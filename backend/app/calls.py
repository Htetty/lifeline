"""Per-call processing shared by the REST endpoints, the voice stream and the browser bridge."""

import asyncio
import hashlib
import json
import logging
import os
import time
from collections import defaultdict
from typing import Literal

import anthropic
from convex import ConvexError
from pydantic import BaseModel, Field, model_validator

from . import convex_store
from .config import settings
from .extraction import Extraction, ExtractionUnavailable, extract_incident
from .geocode import find_candidate

try:  # Optional ModernBERT tags; the app runs the same without them.
    from .classifier import classify_text_async
except ImportError:
    classify_text_async = None

log = logging.getLogger("flood-backend.calls")

# What the agent says when a save fails. Never claim the report went through.
SAVE_FAILED_TEXT = "I'm having trouble updating the system right now. Please stay on the line with me."

CLASSIFY_TIMEOUT_S = 15
# Background classification tasks, kept referenced until they finish.
_background: set[asyncio.Task] = set()

# Per-call transcript lines and a lock so overlapping utterances are processed in order.
# Convex keeps the saved transcript; this is a cache restored after restarts, and it
# only ever holds lines that were actually saved.
_transcripts: dict[str, list[str]] = {}
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
# Calls that already have an incident in Convex.
_has_incident: set[str] = set()


class Utterance(BaseModel):
    speaker: Literal["caller", "agent"]
    text: str = Field(min_length=1, max_length=10000, pattern=r"\S")
    # "simulation": a scripted caller from scripts/demo_sim.py, which pins the location itself.
    source: Literal["live_demo", "recording", "simulation"] = "live_demo"
    # Optional turn identity (browser bridge): makes retries idempotent via Convex receipts.
    turn_id: str | None = Field(default=None, min_length=1, max_length=200)
    sequence: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def identity_pair(self):
        if (self.turn_id is None) != (self.sequence is None) or not self.text.strip():
            raise ValueError("Turn identity/sequence must be paired and speech nonempty")
        return self


class UtteranceResult(BaseModel):
    # True only once Convex has stored the transcript. The voice layer may tell the
    # caller their report is saved only when this is true.
    saved: bool
    incident: dict | None
    extraction: Extraction | None
    next_question: str | None
    location_match: str | None = None
    extraction_error: str | None = None


class SaveFailed(Exception):
    """The update could not be saved to Convex; the caller must not be told it was."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


async def _load_transcript(call_id: str) -> list[str]:
    if call_id not in _transcripts:
        saved = await convex_store.transcript_for_call(call_id)
        _transcripts[call_id] = saved.split("\n") if saved else []
        if saved:
            _has_incident.add(call_id)
    return _transcripts[call_id]


async def _confirmed_status_text(call_id: str) -> str:
    """What the agent may truthfully say about progress right now."""
    try:
        status = (await convex_store.call_state(call_id))["status"]
    except Exception:
        log.warning("call %s: couldn't read status for a status question", call_id)
        return "I'm checking on that for you."
    return status["sayIfAsked"] if status else "I'm passing your details to the dispatcher now."


async def _classify(call_id: str, version: int, transcript: str) -> None:
    """Store advisory topic tags. Never raises: classification is optional."""
    caller_text = "\n".join(line[len("Caller: "):] for line in transcript.split("\n") if line.startswith("Caller: "))
    try:
        result = await asyncio.wait_for(classify_text_async(caller_text), CLASSIFY_TIMEOUT_S)
        await convex_store.set_advisory_tags(
            call_id,
            status=result["status"],
            tags=result["predicted_tags"] or [],
            model_version=result["model_version"],
            based_on_version=version,
        )
    except Exception as e:
        log.warning("call %s: advisory classification skipped (%s)", call_id, type(e).__name__)


async def process_utterance(
    call_id: str, utterance: Utterance, *, extract: bool = True, latest_message: str | None = None
) -> UtteranceResult:
    """Save a turn and (by default) extract facts from the whole transcript.

    extract=False saves a caller turn without extraction, for a voice session that already
    has a newer caller turn queued: that turn's extraction reads the whole transcript, with
    `latest_message` covering every caller turn saved since the last extraction.
    """
    async with _locks[call_id]:
        started = time.monotonic()
        extract_s = map_s = 0.0
        turn = None
        if utterance.turn_id:
            turn = {
                "turnId": utterance.turn_id,
                "sequence": utterance.sequence,
                "fingerprint": hashlib.sha256(
                    json.dumps([utterance.speaker, utterance.text], ensure_ascii=False).encode()
                ).hexdigest(),
            }
            receipt = await convex_store.turn_receipt(call_id, turn)
            if receipt is not None:
                return UtteranceResult.model_validate(receipt)
            # Never append to uncommitted local state. A retry after a lost mutation
            # response reads the durable receipt before extraction or persistence.
            saved = await convex_store.transcript_for_call(call_id)
            lines = saved.split("\n") if saved else []
        else:
            lines = list(await _load_transcript(call_id))
        label = "Caller" if utterance.speaker == "caller" else "Agent"
        lines.append(f"{label}: {utterance.text.strip()}")
        transcript = "\n".join(lines)

        # The agent's greeting alone shouldn't create an incident; keep it for the transcript.
        if utterance.speaker == "agent" and call_id not in _has_incident and not turn:
            _transcripts[call_id] = lines
            return UtteranceResult(saved=False, incident=None, extraction=None, next_question=None)

        extraction: Extraction | None = None
        error: str | None = None
        if utterance.speaker == "caller" and extract:
            try:
                recorded = await convex_store.recorded_hazards(call_id)
            except Exception:  # only a naming hint for withdrawals; extraction works without it
                log.warning("call %s: couldn't read recorded hazards", call_id)
                recorded = None
            try:
                t = time.monotonic()
                # Simulated callers use the cheaper simulation model; live callers always get CLAUDE_MODEL.
                model = settings.sim_claude_model if utterance.source == "simulation" else None
                extraction = await extract_incident(transcript, recorded, latest_message, model=model)
                extract_s = time.monotonic() - t
            except ExtractionUnavailable as e:
                error = f"Extraction unavailable ({e}); the dispatcher will read the transcript."
            except anthropic.APIError as e:
                error = f"Claude request failed ({type(e).__name__}); the dispatcher will read the transcript."
            except Exception as e:  # e.g. missing credentials; never lose the caller's report
                log.exception("call %s: extraction crashed", call_id)
                error = f"Extraction failed ({type(e).__name__}); the dispatcher will read the transcript."
            if error:
                log.warning("call %s: %s", call_id, error)

        # Place the incident on the map when the caller named a findable place (never raises).
        # Convex ignores candidates once the dispatcher has confirmed a location. Simulated calls
        # are skipped: the map search allows one request a second, and live callers come first.
        t = time.monotonic()
        searchable = extraction and utterance.source != "simulation"
        candidate = await find_candidate(extraction.location_queries) if searchable else None
        map_s = time.monotonic() - t
        if candidate:
            log.info("call %s: location candidate %r from %r", call_id, candidate.label, candidate.query)

        # "Is anyone coming?": answer with the confirmed status (approved wording) first.
        next_question = extraction.next_question if extraction else None
        if extraction and extraction.caller_asked_status:
            next_question = " ".join(filter(None, [await _confirmed_status_text(call_id), next_question]))

        # Save even when extraction fails, so the report is never lost.
        response = dict(
            saved=True,
            incident=None,
            extraction=extraction.model_dump() if extraction else None,
            next_question=next_question,
            location_match=candidate.label if candidate else None,
            extraction_error=error,
        )
        try:
            # In turn mode Convex stores `response` as the turn's receipt, atomically with the write.
            incident = await convex_store.upsert_from_call(
                call_id,
                utterance.source,
                transcript,
                turn=turn,
                response=response,
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
                        water_report=extraction.water_report.model_dump() if extraction.water_report else None,
                        withdrawn=[w.model_dump() for w in extraction.withdrawn],
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
            log.error("call %s: NOT saved, Convex rejected the update", call_id)
            raise SaveFailed(f"Not stored: Convex rejected the update: {e.data}", 502) from e
        except Exception as e:
            log.error("call %s: NOT saved, Convex unreachable (%s)", call_id, type(e).__name__)
            raise SaveFailed("Not stored: incident storage is unreachable", 503) from e
        _has_incident.add(call_id)
        _transcripts[call_id] = lines

        # Turn mode returns the stored receipt, which wraps the incident status.
        version = (incident.get("incident") if turn else incident or {}).get("version")
        if classify_text_async and os.environ.get("CLASSIFIER_MODEL_PATH") and utterance.speaker == "caller" and extract and version:
            task = asyncio.create_task(_classify(call_id, int(version), transcript))
            _background.add(task)
            task.add_done_callback(_background.discard)

        if utterance.speaker == "caller":
            # Timing only, never caller words: where a reply's delay comes from.
            log.info("call %s: caller turn saved in %d ms (extraction %d ms, map %d ms, coalesced=%s)", call_id,
                     (time.monotonic() - started) * 1000, extract_s * 1000, map_s * 1000, not extract)
        if turn:
            return UtteranceResult.model_validate(incident)
        return UtteranceResult(
            saved=True,
            incident=incident,
            extraction=extraction,
            next_question=response["next_question"],
            location_match=response["location_match"],
            extraction_error=error,
        )


async def end_call(call_id: str) -> None:
    """The caller hung up. The incident stays open until a dispatcher resolves it."""
    await convex_store.call_ended(call_id)
    # Free per-call memory; a late utterance reloads the transcript from Convex.
    _transcripts.pop(call_id, None)
    _has_incident.discard(call_id)
    _locks.pop(call_id, None)
