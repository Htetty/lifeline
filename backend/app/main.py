"""FastAPI voice backend.

The voice layer (Cartesia) posts each finished utterance here. The backend keeps
the transcript, asks Claude for the incident facts, and saves them to Convex,
which the dispatcher dashboard reads live. Confirmed dispatcher decisions come
back as announcements the voice layer speaks at a natural pause.
"""

import asyncio
import logging
from collections import defaultdict
from typing import Literal

import anthropic
from convex import ConvexError
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import convex_store
from .extraction import Extraction, ExtractionUnavailable, extract_incident
from .geocode import find_candidate

log = logging.getLogger("flood-backend")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Flood Rescue Voice Backend")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://localhost:3100"], allow_methods=["*"])

# Approved status wording. The agent speaks only these for confirmed changes,
# so it never promises more than the dispatcher has approved.
ANNOUNCEMENTS = {
    "assignment_approved": (
        "Update from the dispatcher: a rescue team{team} has been assigned to you. "
        "Stay where you are, keep to the highest safe place, and keep your phone with you."
    ),
    "team_en_route": "Update: the rescue team is on its way to you now. Stay where you are and stay above the water.",
    "rescue_resolved": "The dispatcher has marked your rescue as complete. If you still need help, tell me now.",
}

# Per-call transcript lines and a lock so overlapping utterances are processed in order.
# In-memory is fine for the demo; Convex keeps the saved transcript.
_transcripts: dict[str, list[str]] = defaultdict(list)
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


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


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/calls/{call_id}/utterances", response_model=UtteranceResult)
async def add_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    async with _locks[call_id]:
        label = "Caller" if utterance.speaker == "caller" else "Agent"
        _transcripts[call_id].append(f"{label}: {utterance.text.strip()}")
        transcript = "\n".join(_transcripts[call_id])

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

        return UtteranceResult(
            incident=incident,
            extraction=extraction,
            next_question=extraction.next_question if extraction else None,
            location_match=candidate.label if candidate else None,
            extraction_error=error,
        )


@app.post("/calls/{call_id}/end")
async def end_call(call_id: str):
    """The caller hung up. The incident stays open until a dispatcher resolves it."""
    await convex_store.call_ended(call_id)
    return {"ok": True}


@app.get("/calls/{call_id}/status")
async def call_status(call_id: str):
    """Confirmed status, for answering 'is someone coming?' truthfully."""
    status = await convex_store.status_for_call(call_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No incident for this call yet")
    return status


@app.get("/calls/{call_id}/announcements")
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


@app.post("/calls/{call_id}/announcements/{event_id}/ack")
async def ack_announcement(call_id: str, event_id: str):
    """Call after the update was actually played to the caller."""
    await convex_store.mark_announced(event_id)
    return {"ok": True}
