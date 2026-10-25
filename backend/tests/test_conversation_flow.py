"""The phone conversation leads the intake while responding to what the caller says.

Replays real calls from 2026-10-25 with scripted model results and a scripted Photon
status, through the real session paths: provider turn events, the worker, the poll loop
and playback completion. Assertions are about what is spoken, in what order, and what
state each reply was written against, not about exact model wording (the live-model
replay covers wording and judgement).
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import convex_store, extraction as extraction_module, location_share as ls, main
from app.extraction import Extraction
from app.voice import Playback, Session

CALL = "CA" + "b" * 32
CALLER = "+15555550124"
POINT = {"latitude": 32.7612, "longitude": -117.1675, "accuracyMeters": 80, "capturedAt": "2026-10-25T10:00:00.000Z"}
WATER = "Is water coming into the building where you are?"
COUNT = "How many people need help, including you?"
BASE = dict(caller_role="trapped", reported_address=None, people_count=None, reported_position=None,
            location_queries=[], location_changed=False, hazards=[], risk_factors=[], summary="", missing=[],
            caller_asked_status=False, next_question=WATER, caller_at_rescue_location="yes")


def turn(**fields):
    return Extraction.model_validate({**BASE, **fields})


class Photon:
    """The control API, with the request's status set by the test."""
    def __init__(self):
        self.status, self.location, self.created = "sending", None, []

    async def post(self, path, body):
        if path == "/eligibility":
            return 200, {"eligible": True}
        if path == "/requests":
            self.created.append(body)
            self.id = body["requestId"]
            return 201, {"requestId": body["requestId"], "callId": body["callId"], "status": "sending"}
        if path.endswith("/cancel"):
            return 200, {"requestId": path.split("/")[2], "callId": body["callId"], "status": "cancelled"}
        return 200, {"requestId": path.split("/")[2], "callId": body["callId"], "status": self.status,
                     **({"location": self.location} if self.location else {})}


class Call:
    """A voice session whose caller-turn model results come from `script(text, state)` and
    whose between-turn continuation comes from `continuation(transcript, state)`."""
    def __init__(self, monkeypatch, script, continuation=None):
        self.photon = Photon()
        self.s = Session(CALL, SimpleNamespace(synthesize=AsyncMock(return_value=b"audio")), AsyncMock())
        self.s.location = ls.LocationShare(CALL, CALLER, self.photon)
        self.s.location.eligible = True
        self.states, self.spoken, self.lines, self.continuations = [], [], [], []

        async def process(call_id, utterance, **options):
            if utterance.speaker == "agent":
                return SimpleNamespace(incident={}, extraction=None, extraction_error=None, reply=None)
            state = options.get("conversation_state", "")
            self.states.append(state)
            extraction, reply = script(utterance.text, state)
            return SimpleNamespace(incident={}, extraction_error=None, extraction=extraction, reply=reply)

        async def continue_after_location(transcript, state):
            self.continuations.append((transcript, state))
            if continuation is None:
                raise RuntimeError("no continuation in this test")
            return await continuation(transcript, state) if asyncio.iscoroutinefunction(continuation) \
                else continuation(transcript, state)
        monkeypatch.setattr(main, "process_utterance", process)
        monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[]))
        monkeypatch.setattr(convex_store, "transcript_for_call", AsyncMock(side_effect=lambda _: "\n".join(self.lines)))
        monkeypatch.setattr(extraction_module, "continue_after_location", continue_after_location)
        monkeypatch.setattr(self.s, "speak", self.heard)
        self.worker = asyncio.create_task(self.s.worker())

    def heard(self, text, *args, **kwargs):
        # Stands in for synthesis + playback: heard in full; the poll loop completes it.
        self.spoken.append(text)
        self.lines.append(f"Agent: {text}")
        self.s.playback = Playback(f"p{len(self.spoken)}", text, phase="completed")
        self.s.last_audible = self.s.playback
        return True

    async def finish_playback(self):
        if self.s.playback and self.s.playback.phase == "completed":
            await self.s.complete(self.s.playback)
        await asyncio.wait_for(self.s.queue.join(), 2)

    async def caller(self, text):
        await self.finish_playback()
        self.lines.append(f"Caller: {text}")
        await self.s.provider_event({"type": "turn.start"})
        await self.s.provider_event({"type": "turn.end", "transcript": text})
        await asyncio.wait_for(self.s.queue.join(), 2)
        await self.settle()

    async def settle(self):
        # Let background work run without waiting on anything a test is deliberately holding.
        for _ in range(5):
            await asyncio.gather(*self.s.location.tasks, return_exceptions=True)
            for _ in range(5):
                await asyncio.sleep(0)

    async def silence(self, polls=3):
        """The caller says nothing: run the poll loop as if a long pause had passed each time."""
        for _ in range(polls):
            await self.finish_playback()
            self.s.last_speech = self.s.last_output_end = 0
            self.s.location.last_refresh = 0
            await self.s.poll_once()
            await self.settle()
        await self.finish_playback()

    def close(self):
        self.worker.cancel()


def received(state):
    return "Shared location: received" in state


def reply_for(text, state):
    """A stand-in model that answers from the state it was given, as the prompt requires."""
    if "Can you send a location" in text:
        return turn(wants_location_link=True, location_status="unknown_to_caller"), None
    if text == "Yes.":
        return turn(location_link_answer="yes", location_status="unknown_to_caller"), "Okay."
    if "4 people" in text:
        return turn(people_count=4, next_question=WATER), f"Thank you, 4 people. {WATER}"
    if "confirmed my location" in text or "location?" in text:
        if not received(state):
            return turn(), "It hasn't come through on my end yet. Tap Confirm on the map if you haven't."
        ack = "I've received the location you shared. " if "hasn't been told" in state else ""
        return turn(follow_up_if_quiet=COUNT), ack + "It's a point from your phone's GPS. I don't have a street address for it."
    return turn(), WATER


async def link_sent(c):
    await c.caller("Uh, I'm a people needing help, but I don't know the address. Can you send a location? link?")
    assert c.spoken == [ls.CONSENT]  # the request is answered first; no canned announcement
    await c.caller("Yes.")
    assert c.spoken[-1] == "Okay." and len(c.photon.created) == 1
    c.photon.status = "sent"
    await c.silence(2)  # the status refresh, then the line
    assert c.spoken[-1] == ls.INSTRUCTIONS


@pytest.mark.asyncio
async def test_a_location_arriving_between_turns_is_acknowledged_and_intake_continues(monkeypatch):
    c = Call(monkeypatch, reply_for, continuation=lambda transcript, state: f"I've received your location. {COUNT}")
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.silence()
        # One line: the acknowledgement with one current question, without the caller restarting.
        assert c.spoken[-1] == f"I've received your location. {COUNT}"
        assert c.spoken.count(c.spoken[-1]) == 1 and ls.RECEIVED not in c.spoken
        transcript, state = c.continuations[0]
        assert "hasn't been told" in state and "Caller: Yes." in transcript
        await c.silence()
        assert c.spoken[-1] == f"I've received your location. {COUNT}"  # nothing more until the caller answers
    finally:
        c.close()


@pytest.mark.asyncio
async def test_the_continuation_is_written_from_the_current_conversation(monkeypatch):
    def continuation(transcript, state):
        # Whatever the model decides, it sees what the caller already said, including volunteered facts.
        assert "There are 4 people" in transcript and "I'm on the roof" in transcript
        return "I've received your location. Is anyone hurt or needing medical help?"
    c = Call(monkeypatch, lambda text, state: (turn(), None), continuation=continuation)
    try:
        await link_sent_without_replies(c)
        await c.caller("There are 4 people.")
        await c.caller("I'm on the roof.")
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.silence()
        assert c.spoken[-1] == "I've received your location. Is anyone hurt or needing medical help?"
    finally:
        c.close()


async def link_sent_without_replies(c):
    c.s.location.awaiting_answer = True
    c.s.location.after_turn(turn(location_link_answer="yes"), None)
    await c.settle()
    c.photon.status = "sent"
    await c.silence(2)


@pytest.mark.asyncio
async def test_if_the_continuation_fails_the_acknowledgement_is_still_said_once(monkeypatch):
    c = Call(monkeypatch, reply_for, continuation=None)  # raises
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.silence()
        assert c.spoken.count(ls.RECEIVED) == 1
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_continuation_that_misses_its_deadline_is_never_said_after_the_plain_acknowledgement(monkeypatch):
    gate = asyncio.Event()

    async def slow(transcript, state):
        await gate.wait()
        return f"I've received your location. {COUNT}"
    c = Call(monkeypatch, reply_for, continuation=slow)
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.silence(2)  # confirmation picked up; continuation started
        c.s.location.continuation_deadline = 0  # it took too long
        c.s.last_speech = c.s.last_output_end = 0
        await c.s.poll_once()
        assert c.spoken[-1] == ls.RECEIVED  # said alone, and now playing
        gate.set()
        await asyncio.gather(c.s.continuing, return_exceptions=True)
        await c.silence()
        assert len([line for line in c.spoken if "received" in line.lower()]) == 1
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_caller_speaking_while_the_continuation_is_written_gets_one_acknowledgement(monkeypatch):
    gate = asyncio.Event()

    async def slow(transcript, state):
        await gate.wait()
        return f"I've received your location. {COUNT}"
    c = Call(monkeypatch, reply_for, continuation=slow)
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        c.s.last_speech = c.s.last_output_end = 0
        c.s.location.last_refresh = 0
        await c.s.poll_once()  # picks up the confirmation
        await asyncio.gather(*c.s.location.tasks)
        await c.s.poll_once()  # starts writing the continuation
        assert c.s.continuing and not c.s.continuing.done()
        await c.caller("What's my location?")  # the caller speaks first
        assert c.spoken[-1].startswith("I've received the location you shared.")
        gate.set()
        await asyncio.wait_for(c.s.continuing, 1)  # finishes after the caller spoke: discarded
        assert c.s.location.continuation in {None, "plain"}
        await c.silence()
        acks = [line for line in c.spoken if "received" in line.lower()]
        assert len(acks) == 1  # the written continuation was discarded
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_confirmation_found_during_a_caller_turn_is_acknowledged_by_that_reply_only(monkeypatch):
    c = Call(monkeypatch, reply_for, continuation=lambda t, s: f"I've received your location. {COUNT}")
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.caller("I just confirmed my location.")  # refreshed before the reply was written
        assert received(c.states[-1]) and c.spoken[-1].startswith("I've received the location you shared.")
        await c.silence()
        assert c.continuations == []
        assert len([line for line in c.spoken if "received" in line.lower()]) == 1
    finally:
        c.close()


@pytest.mark.asyncio
async def test_after_a_standalone_answer_intake_resumes_once_if_the_caller_goes_quiet(monkeypatch):
    c = Call(monkeypatch, reply_for, continuation=lambda t, s: "I've received your location.")
    try:
        await link_sent(c)
        c.photon.status, c.photon.location = "confirmed", POINT
        await c.silence()
        await c.caller("What's my location?")
        answer = c.spoken[-1]
        assert "street address" in answer and not answer.endswith("?")
        await c.silence()
        assert c.spoken[-1] == COUNT  # no "Hello?" needed
        await c.silence()
        assert c.spoken.count(COUNT) == 1  # once, never a loop
    finally:
        c.close()


@pytest.mark.asyncio
async def test_the_quiet_follow_up_is_dropped_when_the_caller_speaks_or_something_else_is_said(monkeypatch):
    replies = {"What's my location?": (turn(follow_up_if_quiet=COUNT), "I don't have a street address for it."),
               "Okay, thanks.": (turn(), None)}
    c = Call(monkeypatch, lambda text, state: replies[text])
    try:
        await c.caller("What's my location?")
        await c.caller("Okay, thanks.")  # the caller spoke: that turn decides what comes next
        await c.silence()
        assert COUNT not in c.spoken
        await c.caller("What's my location?")
        c.s.location.outbox.append(("instructions", ls.INSTRUCTIONS))  # another line takes the pause
        await c.silence()
        assert c.spoken[-1] == ls.INSTRUCTIONS and COUNT not in c.spoken
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_caller_who_pushes_back_is_not_asked_the_same_question_again(monkeypatch):
    replies = iter([(turn(), WATER), (turn(follow_up_if_quiet=WATER), WATER), (turn(), "Okay. Is anyone hurt?")])
    c = Call(monkeypatch, lambda text, state: next(replies))
    try:
        await c.caller("We're on the second floor.")
        await c.caller("Hold on, I don't want to answer that.")
        await c.silence()
        await c.caller("Fine, no water inside.")
        assert c.spoken == [WATER, "Okay. Is anyone hurt?"]
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_question_asked_again_by_the_caller_can_be_answered_again(monkeypatch):
    answer = "I don't have a street address for it."
    c = Call(monkeypatch, lambda text, state: (turn(), answer))
    try:
        await c.caller("What's my location?")
        await c.caller("Sorry, what's my location?")
        assert c.spoken == [answer, answer]
    finally:
        c.close()


@pytest.mark.asyncio
async def test_the_recorded_pending_confirmation_is_answered_from_provider_state(monkeypatch):
    c = Call(monkeypatch, reply_for)
    try:
        await link_sent(c)
        await c.caller("Uh, no, but we just need uh someone to call. I actually uh I just confirmed my location.")
        assert "No location has been received" in c.states[-1]
        assert c.spoken[-1].startswith("It hasn't come through")
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_reply_written_before_the_link_status_changed_is_not_spoken(monkeypatch):
    def script(text, state):
        if text == "Has it been sent?":
            # The status moves on while the model is still writing its reply.
            c.s.location.apply({"requestId": c.photon.id, "callId": CALL, "status": "delivered"})
            return turn(), "It hasn't been sent yet."
        return reply_for(text, state)
    c = Call(monkeypatch, script)
    try:
        await link_sent(c)
        await c.caller("Has it been sent?")
        assert "It hasn't been sent yet." not in c.spoken
    finally:
        c.close()


@pytest.mark.asyncio
async def test_a_deferred_reply_is_dropped_when_the_link_status_changes(monkeypatch):
    s = Session(CALL, SimpleNamespace(synthesize=AsyncMock(return_value=b"audio")), AsyncMock())
    s.location = ls.LocationShare(CALL, CALLER, Photon())
    s.last_speech = s.last_output_end = 0
    s.deferred_question = ("It hasn't come through yet.", s.generation, s.location.version)
    s.location.version += 1  # e.g. the confirmation arrived while a dispatcher update played
    spoken = []
    monkeypatch.setattr(s, "speak", lambda text, *a, **k: spoken.append(text) or True)
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[]))
    await s.poll_once()
    assert spoken == [] and s.deferred_question is None


@pytest.mark.asyncio
async def test_dispatcher_updates_still_go_before_location_lines_and_follow_ups(monkeypatch):
    c = Call(monkeypatch, lambda text, state: (turn(follow_up_if_quiet=COUNT), "I don't have a street address for it."))
    try:
        await c.caller("What's my location?")
        update = {"eventId": "e1", "type": "dispatcher_message", "text": "The dispatcher asked me to tell you: stay on the roof."}
        main.announcements.return_value = [update]
        await c.finish_playback()
        c.s.last_speech = c.s.last_output_end = 0
        await c.s.poll_once()
        assert c.spoken[-1] == update["text"]
    finally:
        c.close()


# Routine bookkeeping is never spoken and never holds up the conversation -----------------

DETAILS = {"_id": "d1", "type": "details_received", "text": "I've passed your details to the dispatcher. Stay on the line with me."}
CONFIRMED = {"_id": "e1", "type": "location_confirmed", "text": "The dispatcher has confirmed your location and is arranging a rescue team."}


@pytest.mark.asyncio
async def test_a_new_incident_does_not_trigger_the_canned_announcement(monkeypatch):
    events = [DETAILS]
    async def query(name, args):
        if name == "calls:pendingEvents":
            return list(events)
        if name == "calls:callState":
            return {"status": {}, "pending": [{**DETAILS, "eventId": "d1"}]}
        raise AssertionError(name)
    monkeypatch.setattr(convex_store, "_query", query)
    assert await convex_store.pending_events(CALL) == []
    assert (await convex_store.call_state(CALL))["pending"] == []
    assert await main.announcements(CALL) == []

    # The caller's reply is spoken now, not deferred behind the internal event.
    s = Session(CALL, SimpleNamespace(synthesize=AsyncMock(return_value=b"audio")), AsyncMock())
    s.speak("Can I send you a link in Messages to share your current location?")
    await s.audio_task
    assert s.deferred_question is None
    assert s.send.await_args.args[0]["type"] == "audio_offer"

    # A real dispatcher update still goes first and still holds the reply until it's heard.
    events.append(CONFIRMED)
    assert [e["type"] for e in await convex_store.pending_events(CALL)] == ["location_confirmed"]
    s.playback = None
    s.speak("Is anyone hurt?")
    await s.audio_task
    assert s.deferred_question[0] == "Is anyone hurt?"


@pytest.mark.asyncio
async def test_no_follow_up_is_added_after_a_reply_that_already_asked_something(monkeypatch):
    asked = "Okay. Is anyone hurt or needing medical help?"
    c = Call(monkeypatch, lambda text, state: (turn(follow_up_if_quiet=COUNT), asked))
    try:
        await c.caller("We're on the roof.")
        await c.silence()
        assert c.spoken == [asked]  # the caller is answering a question; no second one stacked on
    finally:
        c.close()
