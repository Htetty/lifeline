"""Phone controller (PR #9) on dev's caller updates: saved wording, new event types, ordering."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import main
from app.voice import QUIET_SECONDS, Playback, Session

WITNESS_TEXT = ("Update: a rescue team, High-Water Truck 7, has been assigned to the people you reported. "
                "Please keep yourself safe and away from the water.")
CHANGED = {"_id": "changed", "type": "assignment_changed", "teamName": "High-Water Truck 7", "announcedAt": None,
           "text": "Update: the dispatcher is arranging a different rescue team for you. "
                   "You're still in the queue; stay where you are."}
MESSAGE = {"_id": "message", "type": "dispatcher_message", "teamName": None, "announcedAt": 50,
           "text": "The dispatcher asked me to tell you: move to the top floor."}


@pytest.fixture
def session(monkeypatch):
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[]))
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[]))
    monkeypatch.setattr(main.convex_store, "current_announcement", AsyncMock(return_value=None))
    s = Session("call", SimpleNamespace(synthesize=AsyncMock(return_value=b"audio")), AsyncMock())
    s.last_speech = 0
    return s


async def idle_poll(session):
    session.last_output_end = time.monotonic() - QUIET_SECONDS - 0.1
    await session.poll_once()
    if session.audio_task:
        await session.audio_task


@pytest.mark.asyncio
async def test_pending_update_is_spoken_with_its_saved_witness_wording(session, monkeypatch):
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[
        {"eventId": "witness-assignment", "type": "assignment_approved", "text": WITNESS_TEXT, "createdAt": 1}]))
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[{"_id": "witness-assignment"}]))
    await idle_poll(session)
    assert session.playback.text == WITNESS_TEXT
    assert session.playback.event_id == "witness-assignment" and not session.playback.replay


@pytest.mark.asyncio
async def test_team_question_after_unassignment_gets_the_truthful_change_update(session, monkeypatch):
    current = AsyncMock(return_value=CHANGED)
    monkeypatch.setattr(main.convex_store, "current_announcement", current)
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[CHANGED]))
    assert session.repeat_request("Which team is coming for us?", "ink-7")
    await idle_poll(session)
    current.assert_awaited_once_with("call", None)  # latest still-true status update
    assert session.playback.text == CHANGED["text"] and "High-Water Truck 7" not in session.playback.text
    assert session.playback.event_id == "changed"
    assert not session.playback.replay  # not yet heard: completing it acknowledges it
    ack = AsyncMock(return_value={"acknowledged": True})
    monkeypatch.setattr(main.convex_store, "mark_announced", ack)
    await session.playback_event("playback_ready", session.playback.id)
    await session.playback_event("playback_complete", session.playback.id)
    ack.assert_awaited_once_with("call", "changed")


@pytest.mark.asyncio
async def test_say_that_again_replays_the_same_dispatcher_message_without_reacknowledging(session, monkeypatch):
    current = AsyncMock(return_value=MESSAGE)
    monkeypatch.setattr(main.convex_store, "current_announcement", current)
    session.last_audible = Playback("heard", MESSAGE["text"], "message", "completed")
    assert session.repeat_request("Sorry, can you say that again?", "ink-8")
    await idle_poll(session)
    # Looked up by id, and re-checked by id after synthesis: never the latest other update.
    assert [c.args for c in current.await_args_list] == [("call", "message")] * 2
    assert session.playback.text == MESSAGE["text"] and session.playback.replay


@pytest.mark.asyncio
async def test_question_behind_a_pending_update_is_asked_after_it_not_dropped(session, monkeypatch):
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[{"_id": "details"}]))
    session.speak("How many people are with you?")
    await session.audio_task
    assert session.playback is None and session.deferred_question[0] == "How many people are with you?"
    # The update goes first ...
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[
        {"eventId": "details", "type": "location_confirmed", "createdAt": 1,
         "text": "The dispatcher has confirmed your location and is arranging a rescue team."}]))
    await idle_poll(session)
    assert session.playback.event_id == "details"
    monkeypatch.setattr(main.convex_store, "mark_announced", AsyncMock(return_value={"acknowledged": True}))
    await session.playback_event("playback_ready", session.playback.id)
    await session.playback_event("playback_complete", session.playback.id)
    session.queue.get_nowait(); session.queue.task_done()  # the spoken update joins the transcript
    # ... then the question, after the usual pause.
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[]))
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[]))
    await session.poll_once()
    assert session.audio_task.done() and session.playback is None  # still inside the quiet pause
    await idle_poll(session)
    assert session.playback.text == "How many people are with you?" and session.deferred_question is None


@pytest.mark.asyncio
async def test_deferred_question_is_dropped_once_the_caller_speaks_again(session, monkeypatch):
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[{"_id": "details"}]))
    session.speak("How many people are with you?")
    await session.audio_task
    await session.provider_event({"type": "turn.start"})  # caller talks; their new turn gets its own reply
    session.open_turn = False
    session.last_speech = 0
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[]))
    await idle_poll(session)
    assert session.playback is None and session.deferred_question is None
    assert session.speech.synthesize.await_count == 1


@pytest.mark.asyncio
async def test_polling_failure_is_logged_and_retried_not_fatal(session, monkeypatch, caplog):
    monkeypatch.setattr(main, "announcements", AsyncMock(side_effect=ConnectionRefusedError("storage down")))
    await idle_poll(session)
    assert "Announcement check delayed (ConnectionRefusedError)" in caplog.text
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[
        {"eventId": "e", "type": "location_confirmed", "createdAt": 1, "text": "The dispatcher has confirmed your location."}]))
    monkeypatch.setattr(main.convex_store, "pending_events", AsyncMock(return_value=[{"_id": "e"}]))
    await idle_poll(session)
    assert session.playback.event_id == "e"
    await asyncio.sleep(0)
