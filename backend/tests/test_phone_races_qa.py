"""Independent playback race/failure checks; all storage/speech are mocked."""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import main, twilio_media as phone
from app.voice import Playback, Session


@pytest.mark.asyncio
async def test_phone_poller_uses_exports_available_in_integrated_app(monkeypatch):
    """A clean textual merge must not leave the phone poller importing removed names."""
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[]))
    session = Session("call", SimpleNamespace(synthesize=AsyncMock()), AsyncMock())
    session.last_speech = 0
    await session.poll_once()
    assert session.audio_task is None


@pytest.mark.asyncio
async def test_idle_phone_session_does_not_end_from_polling_failure(monkeypatch):
    disconnected, provider_closed = asyncio.Event(), asyncio.Event()

    class Speech:
        configure = AsyncMock()
        close = AsyncMock()
        synthesize = AsyncMock(return_value=b"mulaw")

        @asynccontextmanager
        async def listen(self, rate):
            yield self

        async def send(self, command):
            provider_closed.set()

        def __aiter__(self):
            return self.events()

        async def events(self):
            await provider_closed.wait()
            if False:
                yield None

    async def receive():
        await disconnected.wait()
        return {"type": "websocket.disconnect"}

    monkeypatch.setattr(main.convex_store, "start_voice_call", AsyncMock(return_value={"nextSequence": 1}))
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[]))
    monkeypatch.setattr(main, "end_call", AsyncMock())
    session = Session("call", Speech(), AsyncMock())
    connection = SimpleNamespace(receive=receive, send_json=AsyncMock(), close=AsyncMock())
    running = asyncio.create_task(session.run(connection, 8000))
    try:
        await asyncio.sleep(.05)
        assert not running.done(), "Phone session ended before caller disconnected"
        assert not any(call.args[0]["type"] == "fatal" for call in connection.send_json.await_args_list)
    finally:
        disconnected.set()
        await asyncio.wait_for(running, 2)


@pytest.mark.asyncio
async def test_clear_returned_mark_during_blocked_clear_write_never_completes(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    inbound = asyncio.Queue()

    async def send(data):
        assert data["event"] == "clear"
        entered.set()
        await release.wait()

    transport = phone.TwilioTransport(SimpleNamespace(send_json=send, receive_json=inbound.get), "call", "stream", 1)
    transport.marks["old"] = "pending"
    clearing = asyncio.create_task(transport.send({"type": "audio_stop", "playback_id": "old"}))
    await entered.wait()
    await inbound.put({"event": "mark", "sequenceNumber": "2", "streamSid": "stream", "mark": {"name": "old"}})
    await inbound.put({"event": "stop", "sequenceNumber": "3", "streamSid": "stream", "stop": {"callSid": "call"}})
    await transport.pump()
    assert transport.marks["old"] == "cleared"
    assert (await transport.inbox.get())["type"] == "websocket.disconnect"
    assert transport.inbox.empty(), "clear-returned mark became playback_complete"
    release.set()
    await clearing


@pytest.mark.asyncio
async def test_approval_withdrawn_between_offer_and_ready_cannot_send_media(monkeypatch):
    current = AsyncMock(side_effect=[True, False])
    monkeypatch.setattr(Session, "current", current)
    sent = AsyncMock()
    session = Session("call", SimpleNamespace(synthesize=AsyncMock(return_value=b"mulaw")), sent)
    await session.offer("approved once", "event")
    playback_id = session.playback.id
    await session.playback_event("playback_ready", playback_id)
    assert session.playback is None
    assert not any(call.args[0]["type"] == "audio_go" for call in sent.await_args_list)


@pytest.mark.asyncio
async def test_new_speech_during_replay_synthesis_reserves_and_cancels_slot(monkeypatch):
    entered = asyncio.Event()

    async def synthesis(text):
        entered.set()
        await asyncio.Event().wait()

    session = Session("call", SimpleNamespace(synthesize=synthesis), AsyncMock())
    session.requested_repeat = {"kind": "announcement", "id": "request", "event_id": "event"}
    assert session.speak("assignment", "event", replay=True, request_id="request")
    await entered.wait()
    assert not session.speak("unrelated question")
    await session.provider_event({"type": "turn.start"})
    assert session.playback is None and session.audio_task.cancelled()
    assert session.requested_repeat["id"] == "request"
    assert not any(call.args[0]["type"] == "audio_offer" for call in session.send.await_args_list)


@pytest.mark.asyncio
async def test_failed_persistence_of_repeat_request_cannot_claim_saved_or_start_replay(monkeypatch):
    monkeypatch.setattr(main, "process_utterance", AsyncMock(side_effect=OSError("fixture storage failure")))
    monkeypatch.setattr("app.voice.asyncio.sleep", AsyncMock())
    session = Session("call", SimpleNamespace(synthesize=AsyncMock()), AsyncMock())
    session.last_audible = Playback("old", "assignment", "event", "completed")
    await session.queue.put(("verified-1", "caller", "Can you repeat that?", 0))
    with pytest.raises(OSError):
        await session.worker()
    messages = [call.args[0] for call in session.send.await_args_list]
    assert not any(message["type"] in {"saved", "audio_offer", "audio_go"} for message in messages)
    assert any(message["type"] == "fatal" and "not confirmed saved" in message["text"] for message in messages)
    assert session.requested_repeat is None
    assert session.sequence == 1
