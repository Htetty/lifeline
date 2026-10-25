"""One WebSocket per live call: the voice agent's single connection to the backend.

The backend subscribes to the call's state in Convex and pushes every change, so the
agent never polls. See backend/README.md ("Voice agent stream") for the protocol.
"""

import asyncio
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import convex_store
from .calls import SAVE_FAILED_TEXT, SaveFailed, Utterance, end_call, process_utterance

log = logging.getLogger("flood-backend.stream")

# If nothing new has been announced for this long, offer the agent a truthful
# "still working on it" line based on the current stage.
IDLE_UPDATE_AFTER_S = 75


async def call_stream(ws: WebSocket, call_id: str) -> None:
    await ws.accept()
    sent: set[str] = set()  # announcements pushed to the agent and not yet resolved
    acked: set[str] = set()  # never re-send these, even if a snapshot still lists them
    last_status: dict | None = None
    last_spoken = time.monotonic()
    send_lock = asyncio.Lock()

    async def send(message: dict) -> None:
        async with send_lock:
            await ws.send_json(message)

    async def push_from_convex() -> None:
        nonlocal last_status
        async for snapshot in convex_store.subscribe_call_state(call_id):
            status = snapshot["status"]
            # The version bumps on every transcript save; only push meaningful changes.
            meaningful = {k: v for k, v in status.items() if k != "version"} if status else None
            if meaningful != ({k: v for k, v in last_status.items() if k != "version"} if last_status else None):
                await send({"type": "status", "status": status})
            last_status = status
            pending = {e["eventId"]: e for e in snapshot["pending"]}
            for event_id, event in pending.items():
                if event_id not in sent and event_id not in acked:
                    sent.add(event_id)
                    await send({"type": "announcement", "eventId": event_id, "kind": event["type"], "text": event["text"]})
            # Replaced by a newer update (or acknowledged): don't speak it any more.
            for event_id in sent - pending.keys():
                sent.discard(event_id)
                await send({"type": "announcement_cancelled", "eventId": event_id})

    async def handle_agent_messages() -> None:
        nonlocal last_spoken
        while True:
            message = await ws.receive_json()
            kind = message.get("type")
            if kind == "utterance":
                try:
                    result = await process_utterance(call_id, Utterance(**message))
                    await send({"type": "utterance_result", **result.model_dump()})
                except ValidationError as e:
                    await send({"type": "error", "error": f"Bad utterance: {e.errors()[0]['msg']}"})
                except SaveFailed as e:
                    await send({"type": "error", "error": str(e), "sayToCaller": SAVE_FAILED_TEXT})
            elif kind == "ack":
                # Acknowledged after playback. Remember it, because a snapshot taken before
                # Convex records the ack can still list it as pending.
                event_id = message.get("eventId", "")
                acked.add(event_id)
                sent.discard(event_id)
                await convex_store.mark_announced(call_id, event_id)
                last_spoken = time.monotonic()
            elif kind == "end":
                await end_call(call_id)
                await send({"type": "ended"})
            else:
                await send({"type": "error", "error": f"Unknown message type: {kind!r}"})

    async def idle_updates() -> None:
        nonlocal last_spoken
        while True:
            await asyncio.sleep(5)
            if (
                last_status
                and last_status["callConnected"]
                and last_status["stage"] != "resolved"
                and not sent
                and time.monotonic() - last_spoken > IDLE_UPDATE_AFTER_S
            ):
                last_spoken = time.monotonic()
                await send({"type": "idle_update", "text": last_status["sayIfAsked"]})

    tasks = [asyncio.create_task(t()) for t in (push_from_convex, handle_agent_messages, idle_updates)]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if (exc := task.exception()) and not isinstance(exc, WebSocketDisconnect):
                log.error("call %s stream failed: %r", call_id, exc)
    finally:
        for task in tasks:
            task.cancel()
        log.info("call %s: stream closed", call_id)
