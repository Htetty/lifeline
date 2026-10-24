"""FastAPI voice backend.

The voice agent opens one WebSocket per call (/calls/{id}/stream): it sends each
finished utterance and receives live status and confirmed updates to speak. The
backend keeps the transcript, asks Claude for incident facts, and saves them to
Convex, which the dispatcher dashboard reads live. REST endpoints are kept for
scripts and simple clients.
"""

import logging

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import convex_store
from .calls import SAVE_FAILED_TEXT, SaveFailed, Utterance, UtteranceResult, end_call, process_utterance
from .stream import call_stream

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Flood Rescue Voice Backend")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://localhost:3100"], allow_methods=["*"])


@app.get("/health")
async def health():
    return {"ok": True}


@app.websocket("/calls/{call_id}/stream")
async def stream(ws: WebSocket, call_id: str):
    """Live connection for the voice agent. Protocol in backend/README.md."""
    await call_stream(ws, call_id)


@app.post("/calls/{call_id}/utterances", response_model=UtteranceResult)
async def add_utterance(call_id: str, utterance: Utterance) -> UtteranceResult:
    try:
        return await process_utterance(call_id, utterance)
    except SaveFailed as e:
        raise HTTPException(status_code=502, detail={"error": str(e), "sayToCaller": SAVE_FAILED_TEXT}) from e


@app.post("/calls/{call_id}/end")
async def end(call_id: str):
    """The caller hung up. The incident stays open until a dispatcher resolves it."""
    await end_call(call_id)
    return {"ok": True}


@app.get("/calls/{call_id}/state")
async def call_state(call_id: str):
    """Status card plus updates waiting to be spoken (the same data the stream pushes)."""
    return await convex_store.call_state(call_id)


@app.get("/calls/{call_id}/announcements")
async def announcements(call_id: str):
    """Confirmed updates waiting to be spoken, with the approved wording."""
    return (await convex_store.call_state(call_id))["pending"]


@app.post("/calls/{call_id}/announcements/{event_id}/ack")
async def ack_announcement(call_id: str, event_id: str):
    """Call after the update was actually played to the caller."""
    await convex_store.mark_announced(call_id, event_id)
    return {"ok": True}
