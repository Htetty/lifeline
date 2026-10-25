"""Photon location sharing for a phone call: consent, witnesses, call/recipient binding,
duplicates, failure/expiry and late confirmations. No network: the Photon bridge is a fake."""
import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from app import location_share as ls, main, twilio_media as phone, voice
from app.extraction import Extraction
from app.voice import Playback, Session

CALL = "CA" + "b" * 32
CALLER = "+15555550124"
BASE = dict(caller_role="trapped", reported_address=None, people_count=None, reported_position=None,
            location_queries=[], location_changed=False, hazards=[], risk_factors=[], summary="", missing=[],
            caller_asked_status=False, next_question="How many people are with you?")


def turn(**fields):
    return Extraction.model_validate({**BASE, "caller_at_rescue_location": "yes", **fields})


class Bridge:
    """Records control-API calls; replies are scripted per path prefix."""
    def __init__(self, eligible=True):
        self.calls = []
        self.eligible = eligible
        # Photon sends straight away after consent; the first reply is always "sending".
        self.create_reply = lambda body: (201, {"requestId": body["requestId"], "callId": body["callId"], "status": "sending"})
        self.fail = False

    async def post(self, path, body):
        self.calls.append((path, body))
        if self.fail:
            raise OSError("down")
        if path == "/eligibility":
            return (503, {"error": "reachability_unknown"}) if self.eligible is None else (200, {"eligible": self.eligible})
        if path == "/requests":
            return self.create_reply(body)
        return 200, {"requestId": path.split("/")[2], "callId": body["callId"], "status": "cancelled" if path.endswith("cancel") else "sending"}

    def created(self):
        return [body for path, body in self.calls if path == "/requests"]


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


async def share(recipient=CALLER, save_location=None, **kwargs):
    bridge, clock = Bridge(**kwargs), Clock()
    s = ls.LocationShare(CALL, recipient, bridge, clock=clock, save_location=save_location)
    s.start()
    await settle(s)
    return s, bridge, clock


async def settle(s):
    for _ in range(5):
        await asyncio.gather(*s.tasks, return_exceptions=True)
        await asyncio.sleep(0)


async def consent(s):
    assert s.after_turn(turn(location_status="vague"), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes"), "q")
    await settle(s)


@pytest.mark.asyncio
async def test_clear_address_needs_no_link_and_nothing_sends_before_consent():
    s, bridge, _ = await share()
    assert s.after_turn(turn(location_status="clear"), "q") == "q"
    assert s.after_turn(turn(location_status="not_given"), "q") == "q"
    for status in ("unknown_to_caller", "vague", "contradictory"):
        fresh, _, _ = await share()
        assert fresh.after_turn(turn(location_status=status), "q") == ls.CONSENT
    # The offer alone sends nothing, and an answer to a question that was never heard
    # in full (interrupted) is not consent.
    assert s.after_turn(turn(wants_location_link=True), "q") == ls.CONSENT
    assert s.after_turn(turn(location_link_answer="yes"), "q") == "q"
    await settle(s)
    assert bridge.created() == []
    s.spoken(ls.CONSENT)
    assert s.after_turn(turn(location_link_answer="yes"), "next") == "next"  # intake continues
    await settle(s)
    assert bridge.created() == [{"requestId": s.request["id"], "callId": CALL, "recipient": CALLER}]
    assert len(s.request["id"]) == 32


@pytest.mark.asyncio
async def test_declining_stops_offers_until_the_caller_asks():
    s, bridge, _ = await share()
    s.after_turn(turn(location_status="vague"), "q")
    s.spoken(ls.CONSENT)
    assert s.after_turn(turn(location_link_answer="no", location_status="vague"), "q") == "q"
    assert s.after_turn(turn(location_status="vague"), "q") == "q"
    assert s.after_turn(turn(wants_location_link=True), "q") == ls.CONSENT
    await settle(s)
    assert bridge.created() == []


@pytest.mark.asyncio
async def test_unprompted_offers_are_limited():
    s, _, _ = await share()
    assert [s.after_turn(turn(location_status="vague"), "q") for _ in range(4)] == [ls.CONSENT, ls.CONSENT, "q", "q"]


@pytest.mark.asyncio
async def test_witness_location_is_never_requested():
    s, bridge, _ = await share()
    witness = dict(caller_role="witness", caller_at_rescue_location="no")
    assert s.after_turn(turn(location_status="vague", **witness), "q") == "q"
    assert s.after_turn(turn(wants_location_link=True, **witness), "q") == "q"
    # Unclear: ask first (until heard in full, at most twice), then offer once they say they're there.
    unclear = dict(caller_role="unknown", caller_at_rescue_location="unknown")
    assert s.after_turn(turn(location_status="vague", **unclear), "q") == ls.SAME_PLACE
    s.spoken(ls.SAME_PLACE)
    assert s.after_turn(turn(location_status="vague", **unclear), "q") == "q"
    # Consent given, but the answer to "same location?" turns out no: nothing is sent.
    assert s.after_turn(turn(location_status="vague"), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes", **witness), "q")
    await settle(s)
    assert bridge.created() == []


@pytest.mark.asyncio
async def test_no_trusted_or_eligible_recipient_means_no_link():
    for recipient, eligible in ((None, True), ("anonymous", True), (CALLER, False)):
        s, bridge, _ = await share(recipient, eligible=eligible)
        assert s.after_turn(turn(location_status="vague"), "q") == "q"
        assert s.after_turn(turn(wants_location_link=True), "q") == ls.UNAVAILABLE
        assert s.after_turn(turn(wants_location_link=True), "q") == "q"
        assert bridge.created() == []
    assert ls.LocationShare(CALL, None, Bridge()).recipient is None


@pytest.mark.asyncio
async def test_consent_does_not_send_when_same_location_becomes_unknown():
    s, bridge, _ = await share()
    assert s.after_turn(turn(location_status="vague"), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes", caller_at_rescue_location="unknown"), "q")
    await settle(s)
    assert bridge.created() == []


@pytest.mark.asyncio
async def test_repeat_confirmation_requires_a_new_request_but_new_calls_start_fresh():
    s, bridge, _ = await share()
    await consent(s)
    point = {"latitude": 32.7, "longitude": -117.1, "accuracyMeters": 9, "capturedAt": "fixture"}
    first = s.request["id"]
    s.apply({"requestId": first, "callId": CALL, "status": "confirmed", "location": point})
    assert s.after_turn(turn(location_status="vague"), "q") == "q"
    # An explicit resend gets consent again and creates a distinct request.
    assert s.after_turn(turn(wants_location_link=True), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes"), "q")
    await settle(s)
    assert len(bridge.created()) == 2 and s.request["id"] != first
    await s.close()
    fresh = ls.LocationShare("CA" + "c" * 32, CALLER, bridge, clock=Clock())
    fresh.start()
    await settle(fresh)
    assert fresh.location is None and fresh.requests == 0
    assert fresh.after_turn(turn(location_status="vague"), "q") == ls.CONSENT


@pytest.mark.asyncio
async def test_repeated_processing_and_retries_create_one_request():
    s, bridge, _ = await share()
    await consent(s)
    # The same extraction seen again, more "yes"es, and asks while the request is pending.
    s.after_turn(turn(location_link_answer="yes"), "q")
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes"), "q")
    assert s.after_turn(turn(wants_location_link=True), "q") == "q"
    await settle(s)
    assert len(bridge.created()) == 1
    assert s.request["status"] == "sending"


@pytest.mark.asyncio
async def test_spoken_steps_follow_provider_status_not_the_attempt():
    s, bridge, clock = await share()
    await consent(s)
    assert s.request["status"] == "sending"
    assert s.next_line() is None  # nothing to say until Photon reports progress; no "text us first"
    rid = s.request["id"]
    s.apply({"requestId": rid, "callId": CALL, "status": "accepted"})
    assert s.next_line() is None  # accepted is not sent: no instructions yet
    clock.now += ls.UNCONFIRMED_AFTER_S
    s.tick()
    assert s.next_line() == ls.UNCONFIRMED
    s.spoken(ls.UNCONFIRMED)
    s.apply({"requestId": rid, "callId": CALL, "status": "sent"})
    assert s.next_line() == ls.INSTRUCTIONS
    s.apply({"requestId": rid, "callId": CALL, "status": "delivered"})
    s.spoken(ls.INSTRUCTIONS)
    assert s.next_line() is None  # said once, not again on delivery


@pytest.mark.asyncio
async def test_failed_and_expired_requests_fall_back_to_asking():
    s, bridge, _ = await share()
    bridge.create_reply = lambda body: (409, {"error": "recipient_has_active_request"})
    await consent(s)
    assert s.request["status"] == "failed" and s.next_line() == ls.FAILED
    s.spoken(ls.FAILED)
    # A later explicit ask can try again; a link that expires before confirmation says so.
    bridge.create_reply = Bridge().create_reply
    assert s.after_turn(turn(wants_location_link=True), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes"), "q")
    await settle(s)
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "sent"})
    s.spoken(s.next_line())
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "expired"})
    assert s.next_line() == ls.EXPIRED
    # Photon unreachable: failure, never a claim that it was sent.
    t, down, _ = await share()
    down.fail = True
    await consent(t)
    assert t.request["status"] == "failed" and t.next_line() == ls.FAILED


@pytest.mark.asyncio
async def test_a_number_not_reachable_by_imessage_falls_back_to_asking():
    s, bridge, _ = await share()
    await consent(s)
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "unavailable"})
    assert s.next_line() == ls.NOT_REACHABLE
    assert "iMessage" in ls.NOT_REACHABLE and "haven't sent" in ls.NOT_REACHABLE
    s.spoken(ls.NOT_REACHABLE)
    # No further offers on this call, even if asked; the agent keeps asking verbally.
    assert s.after_turn(turn(location_status="vague"), "q") == "q"
    assert s.after_turn(turn(wants_location_link=True), "q") == "q"
    await settle(s)
    assert len(bridge.created()) == 1


@pytest.mark.asyncio
async def test_unknown_reachability_is_checked_again_rather_than_assumed():
    s, bridge, _ = await share(eligible=None)  # Photon answered 503: couldn't check iMessage
    assert s.eligible is None
    assert s.after_turn(turn(location_status="vague"), "q") == "q"
    await settle(s)
    assert [p for p, _ in bridge.calls].count("/eligibility") == 2
    bridge.eligible = True
    s.after_turn(turn(location_status="vague"), "q")
    await settle(s)
    assert s.eligible is True
    assert s.after_turn(turn(location_status="vague"), "q") == ls.CONSENT


@pytest.mark.asyncio
async def test_confirmation_binds_to_this_call_and_request(caplog):
    s, bridge, _ = await share()
    await consent(s)
    rid = s.request["id"]
    point = {"latitude": 32.7612, "longitude": -117.1675, "accuracyMeters": 9, "capturedAt": "2026-10-25T10:00:00.000Z"}
    for wrong in ({"requestId": "f" * 32, "callId": CALL}, {"requestId": rid, "callId": "CA" + "c" * 32},
                  {"requestId": rid, "callId": CALL, "location": {**point, "latitude": 91}},
                  {"requestId": rid, "callId": CALL, "location": {**point, "accuracyMeters": "9"}}):
        s.apply({**wrong, "status": "confirmed", "location": wrong.get("location", point)})
        assert s.location is None
    with caplog.at_level(logging.INFO, logger="location-share"):
        s.apply({"requestId": rid, "callId": CALL, "status": "confirmed", "location": point})
    assert any(CALL in r.getMessage() and rid in r.getMessage() and "32.761200" in r.getMessage() for r in caplog.records)
    # The acknowledgement waits briefly for a continuation written from the current call
    # (see test_conversation_flow); without one it is said on its own.
    assert s.next_line() is None and s.wants_continuation()
    s.continued(None, s.writing_continuation(), still_quiet=True)
    assert s.next_line() == ls.RECEIVED
    s.spoken(s.next_line())
    assert s.next_line() is None
    state = s.state()
    assert "latitude 32.761200" in state and "9 metres" in state and "No street address" in state
    assert "verified by the dispatcher" in state and "hasn't been told" not in state
    # Confirmed: no further link offers or repeats of the acknowledgement.
    s.apply({"requestId": rid, "callId": CALL, "status": "confirmed", "location": point})
    assert s.after_turn(turn(location_status="vague"), "q") == "q" and s.next_line() is None
    # If the caller turns out not to be with the people needing help, the point is flagged as not the rescue location.
    s.after_turn(turn(caller_at_rescue_location="no"), "q")
    assert "not the rescue location" in s.state()


@pytest.mark.asyncio
async def test_resend_replaces_the_link_and_old_statuses_are_ignored():
    s, bridge, _ = await share()
    await consent(s)
    old = s.request["id"]
    s.apply({"requestId": old, "callId": CALL, "status": "sent"})
    assert s.after_turn(turn(location_status="vague"), "q") == "q"  # not pushed again unprompted
    assert s.after_turn(turn(wants_location_link=True), "q") == ls.CONSENT
    s.spoken(ls.CONSENT)
    s.after_turn(turn(location_link_answer="yes"), "q")
    await settle(s)
    assert [path for path, _ in bridge.calls[-2:]] == [f"/requests/{old}/cancel", "/requests"]
    s.apply({"requestId": old, "callId": CALL, "status": "confirmed",
             "location": {"latitude": 1, "longitude": 1, "accuracyMeters": 1, "capturedAt": "t"}})
    assert s.location is None and s.request["id"] != old


@pytest.mark.asyncio
async def test_call_end_withdraws_the_request_and_late_results_go_nowhere():
    s, bridge, _ = await share()
    await consent(s)
    rid = s.request["id"]
    await s.close()
    assert bridge.calls[-1] == (f"/requests/{rid}/cancel", {"callId": CALL})
    s.apply({"requestId": rid, "callId": CALL, "status": "confirmed",
             "location": {"latitude": 1, "longitude": 1, "accuracyMeters": 1, "capturedAt": "t"}})
    assert s.location is None and s.next_line() is None
    s.tick()
    assert s.tasks == set()


@pytest.mark.asyncio
async def test_status_refresh_is_throttled_and_off_the_speech_path():
    s, bridge, clock = await share()
    await consent(s)
    before = len(bridge.calls)
    s.tick(); s.tick()
    await settle(s)
    clock.now += ls.REFRESH_S
    s.tick()
    await settle(s)
    assert [p for p, _ in bridge.calls[before:]] == [f"/requests/{s.request['id']}/status"] * 2


def test_bridge_needs_a_token_and_a_loopback_url(monkeypatch):
    env = {"PHOTON_BRIDGE_TOKEN": "t" * 40}
    monkeypatch.setattr(ls, "voice_environment", lambda: env)
    assert ls.PhotonBridge.from_env().url == "http://127.0.0.1:8092"
    for bad in ({"PHOTON_BRIDGE_TOKEN": ""}, {"PHOTON_BRIDGE_TOKEN": "short"},
                {**env, "PHOTON_CONTROL_URL": "http://photon.example:8092"}, {**env, "PHOTON_CONTROL_URL": "https://127.0.0.1:8092"}):
        env.clear(); env.update(bad)
        assert ls.PhotonBridge.from_env() is None
    assert ls.LocationShare.for_call(CALL, CALLER) is None  # sharing off: calls behave as before


# Voice session ------------------------------------------------------------------------

POINT = {"latitude": 32.7612, "longitude": -117.1675, "accuracyMeters": 9,
         "capturedAt": "2026-10-25T10:00:00.000Z"}


@pytest.mark.asyncio
async def test_confirmed_fix_updates_the_same_calls_map_candidate_once():
    save = AsyncMock(return_value={"saved": True})
    s, _, _ = await share(save_location=save)
    await consent(s)
    body = {"requestId": s.request["id"], "callId": CALL, "status": "confirmed", "location": POINT}
    for wrong in ({**body, "callId": "CA" + "c" * 32}, {**body, "requestId": "f" * 32}):
        s.apply(wrong)
    save.assert_not_awaited()
    s.apply(body)
    await settle(s)
    save.assert_awaited_once_with(CALL, body["requestId"], POINT)
    assert "saved as the incident's map candidate" in s.state()
    assert "not verified by the dispatcher" in s.state()
    s.apply(body)
    s.tick()
    await settle(s)
    assert save.await_count == 1


@pytest.mark.asyncio
async def test_map_save_retries_a_lost_response_without_repeating_the_location_ack(monkeypatch):
    save = AsyncMock(side_effect=[OSError("response lost"), {"saved": True}])
    monkeypatch.setattr(ls.asyncio, "sleep", AsyncMock())
    s, _, _ = await share(save_location=save)
    await consent(s)
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "confirmed", "location": POINT})
    await settle(s)
    assert save.await_count == 2 and save.await_args_list[0] == save.await_args_list[1]
    assert s.map_saved is True
    assert [kind for kind, _ in s.outbox].count("received") == 1


@pytest.mark.asyncio
async def test_a_witness_or_late_confirmation_never_updates_the_map():
    for ended in (False, True):
        save = AsyncMock()
        s, _, _ = await share(save_location=save)
        await consent(s)
        if ended:
            await s.close()
        else:
            s.after_turn(turn(caller_at_rescue_location="no"), "q")
        s.apply({"requestId": s.request["id"], "callId": CALL, "status": "confirmed", "location": POINT})
        await settle(s)
        save.assert_not_awaited()


@pytest.mark.asyncio
async def test_map_save_is_background_work_and_hangup_bounds_a_stalled_write(monkeypatch):
    monkeypatch.setattr(ls, "MAP_FLUSH_S", 0.01)
    started = asyncio.Event()
    async def save(*args):
        started.set()
        await asyncio.Event().wait()
    s, _, clock = await share(save_location=save)
    await consent(s)
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "confirmed", "location": POINT})
    await asyncio.wait_for(started.wait(), 1)
    clock.now += ls.CONTINUE_WAIT_S
    assert s.next_line() == ls.RECEIVED
    assert s.map_saved is None
    await asyncio.wait_for(s.close(), 1)
    assert not s.tasks


@pytest.mark.asyncio
async def test_hangup_flushes_a_confirmation_already_received_before_the_call_ends():
    save = AsyncMock(return_value={"saved": True})
    s, _, _ = await share(save_location=save)
    await consent(s)
    s.apply({"requestId": s.request["id"], "callId": CALL, "status": "confirmed", "location": POINT})
    # No event-loop yield between accepting Confirm and hang-up.
    await s.close()
    save.assert_awaited_once_with(CALL, s.request["id"], POINT)
    assert s.map_saved is True and s.next_line() is None


def test_phone_sessions_enable_incident_location_writes(monkeypatch):
    from app import convex_store
    save = AsyncMock()
    monkeypatch.setattr(convex_store, "location_from_phone", save)
    monkeypatch.setattr(ls.PhotonBridge, "from_env", lambda: Bridge())
    assert ls.LocationShare.for_call(CALL, CALLER).save_location is save

@pytest.fixture
def session():
    s = Session(CALL, SimpleNamespace(synthesize=AsyncMock(return_value=b"wav")), AsyncMock())
    s.location = ls.LocationShare(CALL, CALLER, Bridge(), clock=Clock())
    s.location.eligible = True
    return s


@pytest.mark.asyncio
async def test_session_offers_after_a_vague_turn_and_shares_the_confirmed_location(session, monkeypatch):
    seen = []

    async def process(call, utterance, **options):
        seen.append(options)
        return SimpleNamespace(incident={}, extraction_error=None, extraction=turn(location_status="vague"), reply="Where are you?")
    monkeypatch.setattr(main, "process_utterance", process)
    spoken = []
    monkeypatch.setattr(session, "speak", lambda text, *a, **k: spoken.append(text) or True)
    await session.queue.put(("ink-1", "caller", "somewhere by the river", 0))
    worker = asyncio.create_task(session.worker())
    try:
        await asyncio.wait_for(session.queue.join(), 1)
        assert spoken == [ls.CONSENT]
        session.location.location = {"latitude": 32.7, "longitude": -117.1, "accuracyMeters": 5, "capturedAt": "t"}
        await session.queue.put(("ink-2", "caller", "two of us", 0))
        await asyncio.wait_for(session.queue.join(), 1)
        # Every extracted turn gets the link's real state; the second includes the received point.
        assert "can be offered" in seen[0]["conversation_state"] and "latitude" not in seen[0]["conversation_state"]
        assert "latitude 32.700000" in seen[1]["conversation_state"]
    finally:
        worker.cancel()


@pytest.mark.asyncio
async def test_dispatcher_updates_and_pending_questions_speak_before_location_lines(session, monkeypatch):
    session.last_speech = session.last_output_end = 0
    session.location.outbox = [("instructions", ls.INSTRUCTIONS)]
    monkeypatch.setattr(main, "announcements", AsyncMock(return_value=[{"eventId": "e1", "text": "Dispatcher update"}]))
    spoken = []
    monkeypatch.setattr(session, "speak", lambda text, *a, **k: spoken.append(text) or True)
    await session.poll_once()
    main.announcements.return_value = []
    session.deferred_question = ("How many people?", session.generation, session.location.version)
    await session.poll_once()
    await session.poll_once()
    assert spoken == ["Dispatcher update", "How many people?", ls.INSTRUCTIONS]
    # Said once: only a complete playback removes it.
    p = Playback("p1", ls.INSTRUCTIONS, phase="completed")
    session.playback = p
    monkeypatch.setattr(voice.convex_store, "mark_announced", AsyncMock())
    await session.complete(p)
    assert session.location.next_line() is None


# Twilio: the recipient is the signed webhook's From, bound to its own call ---------------

def test_signed_caller_number_becomes_the_only_recipient(monkeypatch):
    from tests.test_twilio_media import ACCOUNT, FORM, STREAM, signature, start, webhook  # noqa: F401  (fixtures reused)
    monkeypatch.setattr(phone, "voice_environment", lambda: {
        "TWILIO_ACCOUNT_SID": ACCOUNT, "TWILIO_AUTH_TOKEN": "fixture-signing-token",
        "TWILIO_PHONE_NUMBER": FORM["To"], "TWILIO_PUBLIC_BASE_URL": "https://voice.example.com"})
    phone._leases.clear(); phone._active_calls.clear()
    bound = []
    monkeypatch.setattr(phone.LocationShare, "for_call", classmethod(lambda cls, call, recipient: bound.append((call, recipient)) or "share"))

    class FakeSession:
        def __init__(self, call, speech, send): self.call_id = call

        async def run(self, transport, rate): bound.append(self.location)
    monkeypatch.setattr(phone, "Session", FakeSession)
    monkeypatch.setattr(phone, "CartesiaSpeech", lambda **kwargs: object())
    try:
        with TestClient(main.app) as client:
            withheld = {**FORM, "CallSid": "CA" + "e" * 32, "From": "anonymous"}
            webhook(client, withheld)
            assert phone._leases[withheld["CallSid"]].caller is None
            token = ElementTree.fromstring(webhook(client).text).find("Connect/Stream/Parameter").attrib["value"]
            assert phone._leases[FORM["CallSid"]].caller == FORM["From"]
            with client.websocket_connect(phone.MEDIA_PATH, headers=signature(phone.MEDIA_PATH)) as ws:
                ws.send_json(start(token))
                with pytest.raises(Exception):
                    ws.receive_json()
        assert bound == [(FORM["CallSid"], FORM["From"]), "share"]
    finally:
        phone._leases.clear(); phone._active_calls.clear()
