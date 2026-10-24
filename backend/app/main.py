"""FastAPI voice backend.

The browser bridge forwards finalized Cartesia STT turns into this workflow;
trusted integrations can also post utterances. The backend keeps the transcript,
asks Claude for incident facts, and saves them to Convex,
which the dispatcher dashboard reads live. Confirmed dispatcher decisions come
back as announcements the voice layer speaks at a natural pause.
"""

import asyncio
import logging
import hashlib
import json
from collections import defaultdict
from typing import Literal

import anthropic
from convex import ConvexError
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from . import convex_store
from .extraction import Extraction, ExtractionUnavailable, extract_incident
from .geocode import find_candidate
from .auth import require_backend

log = logging.getLogger("flood-backend")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Flood Rescue Voice Backend")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://localhost:3100"], allow_methods=["*"])

# Approved status wording. The agent speaks only these for confirmed changes,
# so it never promises more than the dispatcher has approved.
ANNOUNCEMENTS = {
    "assignment_approved": (
        "Simulation update from the dispatcher: a simulated rescue team{team} has been assigned to this fictional incident."
    ),
    "team_en_route": "Simulation update: the dispatcher has marked the simulated team as en route.",
    "rescue_resolved": "Simulation update: the dispatcher has marked this fictional incident as complete.",
}

# Per-call transcript lines and a lock so overlapping utterances are processed in order.
# In-memory is fine for the demo; Convex keeps the saved transcript.
_transcripts: dict[str, list[str]] = {}
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
# Calls that already have an incident in Convex.
_has_incident: set[str] = set()


async def _load_transcript(call_id: str) -> list[str]:
    """Transcript lines for a call, restored from Convex after a backend restart."""
    if call_id not in _transcripts:
        saved = await convex_store.transcript_for_call(call_id)
        _transcripts[call_id] = saved.split("\n") if saved else []
        if saved:
            _has_incident.add(call_id)
    return _transcripts[call_id]


class Utterance(BaseModel):
    speaker: Literal["caller", "agent"]
    text: str = Field(min_length=1, max_length=10000)
    source: Literal["live_demo", "recording"] = "live_demo"
    turn_id: str | None = Field(default=None, min_length=1, max_length=200)
    sequence: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def identity_pair(self):
        if (self.turn_id is None) != (self.sequence is None) or not self.text.strip():
            raise ValueError("Turn identity/sequence must be paired and speech nonempty")
        return self


class UtteranceResult(BaseModel):
    incident: dict | None
    extraction: Extraction | None
    next_question: str | None
    location_match: str | None = None
    extraction_error: str | None = None


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/calls/{call_id}/utterances", response_model=UtteranceResult, dependencies=[Depends(require_backend)])
async def add_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    return await process_utterance(call_id, utterance)


async def process_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    async with _locks[call_id]:
        turn = None
        if utterance.turn_id:
            turn = {"turnId": utterance.turn_id, "sequence": utterance.sequence,
                    "fingerprint": hashlib.sha256(json.dumps([utterance.speaker, utterance.text], ensure_ascii=False).encode()).hexdigest()}
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
        try:
            candidate = await find_candidate(extraction.location_queries) if extraction else None
        except Exception as exc:
            # Map lookup is optional: a dispatcher can place an unverified pin.
            log.warning("Geocoding unavailable (%s); saving caller turn", type(exc).__name__)
            candidate = None
        if candidate:
            log.info("call %s: location candidate %r from %r", call_id, candidate.label, candidate.query)

        # Save even when extraction fails, so the report is never lost.
        try:
            response = dict(incident=None, extraction=extraction.model_dump() if extraction else None,
                            next_question=extraction.next_question if extraction else None,
                            location_match=candidate.label if candidate else None, extraction_error=error)
            incident = await convex_store.upsert_from_call(
                call_id,
                utterance.source,
                transcript,
                turn=turn, response=response,
                **(
                    dict(
                        reported_address=extraction.reported_address,
                        people_count=extraction.people_count,
                        reported_position=extraction.reported_position,
                        hazards=[h.model_dump() for h in extraction.hazards],
                        summary=extraction.summary,
                        location_changed=extraction.location_changed,
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
            raise HTTPException(status_code=502, detail=f"Convex rejected the update: {e.data}") from e
        _has_incident.add(call_id)
        _transcripts[call_id] = lines

        if turn:
            return UtteranceResult.model_validate(incident)

        return UtteranceResult(
            incident=incident,
            extraction=extraction,
            next_question=extraction.next_question if extraction else None,
            location_match=candidate.label if candidate else None,
            extraction_error=error,
        )


@app.post("/calls/{call_id}/end", dependencies=[Depends(require_backend)])
async def end_call(call_id: str):
    """The caller hung up. The incident stays open until a dispatcher resolves it."""
    await convex_store.call_ended(call_id)
    # Free per-call memory; a late utterance reloads the transcript from Convex.
    _transcripts.pop(call_id, None)
    _has_incident.discard(call_id)
    _locks.pop(call_id, None)
    return {"ok": True}


@app.get("/calls/{call_id}/status", dependencies=[Depends(require_backend)])
async def call_status(call_id: str):
    """Confirmed status, for answering 'is someone coming?' truthfully."""
    status = await convex_store.status_for_call(call_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No incident for this call yet")
    return status


@app.get("/calls/{call_id}/announcements", dependencies=[Depends(require_backend)])
async def announcements(call_id: str):
    """Confirmed updates waiting to be spoken, with the approved wording."""
    events = await convex_store.pending_events(call_id)
    return [
        {
            "eventId": e["_id"],
            "type": e["type"],
            "text": ANNOUNCEMENTS[e["type"]].format(team=f", {e['teamName']}," if e.get("teamName") else ""),
            "createdAt": e["createdAt"],
        }
        for e in events
    ]


@app.post("/calls/{call_id}/announcements/{event_id}/ack", dependencies=[Depends(require_backend)])
async def ack_announcement(call_id: str, event_id: str):
    """Call after the update was actually played to the caller."""
    return await convex_store.mark_announced(call_id, event_id)


from .voice import router as voice_router
app.include_router(voice_router)
