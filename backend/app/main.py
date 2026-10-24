"""FastAPI voice backend.

Two ways in for voice:
- the browser voice bridge (/voice, app/voice.py): Cartesia speech-to-text turns in,
  approved updates spoken back with Cartesia TTS;
- any voice client over one WebSocket per call (/calls/{id}/stream), which pushes the
  live status card and confirmed updates (app/stream.py).

Both feed the same utterance processing (app/calls.py): keep the transcript, ask Claude
for incident facts, save them to Convex, which the dispatcher dashboard reads live.
Every /calls route needs `Authorization: Bearer <VOICE_BRIDGE_TOKEN>`.
"""

import logging

from fastapi import Depends, FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import calls, convex_store
from .auth import require_voice, voice_token_ok
from .calls import SAVE_FAILED_TEXT, SaveFailed, Utterance, UtteranceResult
from .stream import call_stream

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Flood Rescue Voice Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3100"],
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)
voice = [Depends(require_voice)]

__all__ = ["app", "Utterance", "process_utterance", "announcements", "end_call"]  # used by app/voice.py


@app.get("/health")
async def health():
    return {"ok": True}


@app.websocket("/calls/{call_id}/stream")
async def stream(ws: WebSocket, call_id: str):
    """Live connection for a voice agent. Protocol in backend/README.md.

    Authenticate with the `Authorization: Bearer` header, or `?token=` for clients
    that can't set WebSocket headers.
    """
    if not voice_token_ok(ws.headers.get("authorization", ""), ws.query_params.get("token")):
        await ws.close(code=4401, reason="Unauthorized")
        return
    await call_stream(ws, call_id)


async def process_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    """HTTP-facing processing (also used by the browser bridge): a failed save is an HTTP error."""
    try:
        return await calls.process_utterance(call_id, utterance)
    except SaveFailed as e:
        # Never 2xx: the caller must not be told the report was saved.
        raise HTTPException(status_code=e.status_code, detail=str(e), headers={"X-Say-To-Caller": SAVE_FAILED_TEXT}) from e


@app.post("/calls/{call_id}/utterances", response_model=UtteranceResult, dependencies=voice)
async def add_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    return await process_utterance(call_id, utterance)


@app.post("/calls/{call_id}/end", dependencies=voice)
async def end_call(call_id: str):
    """The caller hung up. The incident stays open until a dispatcher resolves it.

    After this, announcements for the call come back empty; the voice layer should
    also stop its own polling and any playback.
    """
    await calls.end_call(call_id)
    return {"ok": True}


@app.get("/calls/{call_id}/status", dependencies=voice)
async def call_status(call_id: str):
    """Confirmed status, for answering 'is someone coming?' truthfully."""
    status = await convex_store.status_for_call(call_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No incident for this call yet")
    return status


@app.get("/calls/{call_id}/state", dependencies=voice)
async def call_state(call_id: str):
    """Status card plus updates waiting to be spoken (the same data the stream pushes)."""
    return await convex_store.call_state(call_id)


@app.get("/calls/{call_id}/announcements", dependencies=voice)
async def announcements(call_id: str):
    """Confirmed updates that are still true, with the approved wording.

    Empty once the call ended. An update the dispatcher since reversed or superseded
    is never returned, so poll again right before speaking.
    """
    events = await convex_store.pending_events(call_id)
    return [
        {"eventId": e["_id"], "type": e["type"], "text": e.get("text") or e["type"], "createdAt": e["createdAt"]}
        for e in events
    ]


@app.post("/calls/{call_id}/announcements/{event_id}/ack", dependencies=voice)
async def ack_announcement(call_id: str, event_id: str):
    """Call only after the whole update was played. Don't ack if playback was interrupted.

    `acknowledged` is false when the update is no longer current (or not this call's);
    it stays unheard and the next poll returns whatever is current instead.
    """
    try:
        return await convex_store.mark_announced(call_id, event_id)
    except Exception as e:  # malformed event id fails Convex argument validation
        raise HTTPException(status_code=404, detail="Unknown announcement") from e


from .voice import router as voice_router  # noqa: E402  (voice.py imports names from this module)

app.include_router(voice_router)

from .twilio_media import router as twilio_router
app.include_router(twilio_router)
