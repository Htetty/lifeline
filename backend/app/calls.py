"""Per-call processing shared by the REST and WebSocket endpoints."""

import asyncio
import logging
from collections import defaultdict
from typing import Literal

import anthropic
from convex import ConvexError
from pydantic import BaseModel

from . import convex_store
from .extraction import Extraction, ExtractionUnavailable, extract_incident
from .geocode import find_candidate

log = logging.getLogger("flood-backend.calls")

# What the agent says when a save fails. Never claim the report went through.
SAVE_FAILED_TEXT = "I'm having trouble updating the system right now. Please stay on the line with me."

# Per-call transcript lines and a lock so overlapping utterances are processed in order.
# Convex keeps the saved transcript; this is a cache restored after restarts.
_transcripts: dict[str, list[str]] = {}
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
# Calls that already have an incident in Convex.
_has_incident: set[str] = set()


class Utterance(BaseModel):
    speaker: Literal["caller", "agent"]
    text: str
    source: Literal["live_demo", "recording"] = "live_demo"


class UtteranceResult(BaseModel):
    incident: dict | None
    extraction: Extraction | None
    next_question: str | None
    location_match: str | None = None
    extraction_error: str | None = None


class SaveFailed(Exception):
    """The update could not be saved to Convex; the caller must not be told it was."""


async def _load_transcript(call_id: str) -> list[str]:
    if call_id not in _transcripts:
        saved = await convex_store.transcript_for_call(call_id)
        _transcripts[call_id] = saved.split("\n") if saved else []
        if saved:
            _has_incident.add(call_id)
    return _transcripts[call_id]


async def process_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    async with _locks[call_id]:
        lines = await _load_transcript(call_id)
        label = "Caller" if utterance.speaker == "caller" else "Agent"
        lines.append(f"{label}: {utterance.text.strip()}")
        transcript = "\n".join(lines)

        # The agent's greeting alone shouldn't create an incident; keep it for the transcript.
        if utterance.speaker == "agent" and call_id not in _has_incident:
            return UtteranceResult(incident=None, extraction=None, next_question=None)

        extraction: Extraction | None = None
        error: str | None = None
        if utterance.speaker == "caller":
            try:
                extraction = await extract_incident(transcript)
            except ExtractionUnavailable as e:
                error = f"Extraction unavailable ({e}); transcript saved for the dispatcher."
            except anthropic.APIError as e:
                error = f"Claude request failed ({type(e).__name__}); transcript saved for the dispatcher."
            except Exception as e:  # e.g. missing credentials; never lose the caller's report
                log.exception("call %s: extraction crashed", call_id)
                error = f"Extraction failed ({type(e).__name__}); transcript saved for the dispatcher."
            if error:
                log.warning("call %s: %s", call_id, error)

        # Place the incident on the map when the caller named a findable place.
        # Convex ignores candidates once the dispatcher has confirmed a location.
        candidate = await find_candidate(extraction.location_queries) if extraction else None
        if candidate:
            log.info("call %s: location candidate %r from %r", call_id, candidate.label, candidate.query)

        # Save even when extraction fails, so the report is never lost.
        try:
            incident = await convex_store.upsert_from_call(
                call_id,
                utterance.source,
                transcript,
                **(
                    dict(
                        reported_address=extraction.reported_address,
                        people_count=extraction.people_count,
                        reported_position=extraction.reported_position,
                        hazards=[h.model_dump() for h in extraction.hazards],
                        summary=extraction.summary,
                        location_changed=extraction.location_changed,
                        caller_role=extraction.caller_role,
                        risk_factors=[r.model_dump() for r in extraction.risk_factors],
                        candidate=(
                            (candidate.latitude, candidate.longitude, f"Map search: {candidate.label}")
                            if candidate
                            else None
                        ),
                    )
                    if extraction
                    else {}
                ),
            )
        except ConvexError as e:
            raise SaveFailed(f"Convex rejected the update: {e.data}") from e
        except Exception as e:
            log.exception("call %s: saving to Convex failed", call_id)
            raise SaveFailed(f"Saving to Convex failed ({type(e).__name__})") from e
        _has_incident.add(call_id)

        return UtteranceResult(
            incident=incident,
            extraction=extraction,
            next_question=extraction.next_question if extraction else None,
            location_match=candidate.label if candidate else None,
            extraction_error=error,
        )


async def end_call(call_id: str) -> None:
    """The caller hung up. The incident stays open until a dispatcher resolves it."""
    await convex_store.call_ended(call_id)
    # Free per-call memory; a late utterance reloads the transcript from Convex.
    _transcripts.pop(call_id, None)
    _has_incident.discard(call_id)
