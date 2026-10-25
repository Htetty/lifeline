"""Caller location confirmation: read-back, explicit yes only, corrections, map conflicts.

Claude, Convex and the map search are mocked; the Convex side of these rules (re-checking
each confirmation, holding a changed location) is in dashboard/tests/callerLocation.test.ts.
"""
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import calls, convex_store, geocode, location_check  # noqa: E402
from app.calls import Utterance  # noqa: E402
from app.extraction import Extraction  # noqa: E402
from app.geocode import Candidate  # noqa: E402
from app.location_check import CORRECT_ADDRESS, readback  # noqa: E402

HOME = "1234 Hotel Circle North, apartment 5, San Diego"
OTHER = "456 Hotel Circle South, San Diego"
NEXT = "How many people are with you?"


def facts(**updates) -> Extraction:
    data = dict(
        caller_role="trapped", reported_address="1234 Hotel Circle North", location_unit="apartment 5",
        location_city="San Diego", location_missing=[], people_count=None, reported_position=None,
        location_queries=["1234 Hotel Circle North, San Diego, CA"], location_changed=False, hazards=[],
        risk_factors=[], water_report=None, summary="Caller at home.", missing=[], caller_asked_status=False,
        withdrawn=[], next_question=NEXT,
    )
    data.update(updates)
    return Extraction(**data)


def unconfirmed(address=HOME):
    return {"address": address, "status": "unconfirmed", "pending": None}


def confirmed(address=HOME, pending=None):
    return {"address": address, "status": "confirmed", "pending": pending}


@pytest.fixture
def turn(monkeypatch):
    """Run one caller turn after `before` (saved transcript lines); returns (result, saved kwargs)."""

    async def run(before, said, stored=None, extraction=None, match=None):
        call = f"loc-{uuid.uuid4().hex[:8]}"
        saved = {}

        async def upsert(call_id, source, transcript, **kwargs):
            saved.update(kwargs, transcript=transcript)
            return {"version": 2}

        monkeypatch.setattr(convex_store, "transcript_for_call", AsyncMock(return_value="\n".join(before) or None))
        monkeypatch.setattr(convex_store, "recorded_hazards", AsyncMock(return_value=[]))
        monkeypatch.setattr(convex_store, "caller_location", AsyncMock(return_value=stored))
        monkeypatch.setattr(convex_store, "upsert_from_call", upsert)
        monkeypatch.setattr(calls, "extract_incident", AsyncMock(return_value=extraction or facts()))
        monkeypatch.setattr(calls, "find_candidate", AsyncMock(return_value=match))
        monkeypatch.setattr(calls, "classify_text_async", None)
        try:
            result = await calls.process_utterance(call, Utterance(speaker="caller", text=said))
        finally:
            calls._transcripts.pop(call, None)
            calls._has_incident.discard(call)
        return result, saved

    return run


# 1. Address followed by explicit confirmation.
@pytest.mark.asyncio
async def test_address_is_read_back_then_confirmed_by_explicit_yes(turn):
    result, saved = await turn([], "We're at 1234 Hotel Circle North, apartment 5, in San Diego")
    assert result.next_question == f"I have {HOME}. Is that correct?"
    assert saved["reported_address"] == HOME and saved["location_confirmation"] is None
    assert result.location_confirmed is False  # extracted and geocoded is not confirmed

    heard = ["Caller: We're at 1234 Hotel Circle North, apartment 5, in San Diego", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "Yes, that's right.", unconfirmed())
    assert saved["location_confirmation"] == {"location": HOME, "evidence": "Yes, that's right."}
    assert result.location_confirmed is True
    assert result.next_question == NEXT  # straight back to intake


@pytest.mark.asyncio
async def test_missing_city_is_asked_for_not_invented(turn):
    result, saved = await turn([], "1234 Hotel Circle North", extraction=facts(
        location_unit=None, location_city=None, location_missing=["city"]))
    assert result.next_question == "I have 1234 Hotel Circle North. What city is that in?"
    assert saved["reported_address"] == "1234 Hotel Circle North"
    # Asked once: if they can't say, the read-back follows with what they did give.
    asked = ["Caller: 1234 Hotel Circle North", f"Agent: {result.next_question}"]
    result, _ = await turn(asked, "I don't know", unconfirmed("1234 Hotel Circle North"), facts(
        location_unit=None, location_city=None, location_missing=["city"]))
    assert result.next_question == readback("1234 Hotel Circle North")


# 2. Incorrect address followed by correction and confirmation.
@pytest.mark.asyncio
async def test_correction_is_read_back_again_and_then_confirmed(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "No, it's 456 Hotel Circle South in San Diego", unconfirmed(), facts(
        reported_address="456 Hotel Circle South", location_unit=None, location_changed=True))
    assert saved["location_confirmation"] is None and result.location_confirmed is False
    assert saved["reported_address"] == OTHER
    assert result.next_question == readback(OTHER)

    heard += ["Caller: No, it's 456 Hotel Circle South in San Diego", f"Agent: {readback(OTHER)}"]
    result, saved = await turn(heard, "Yes", unconfirmed(OTHER), facts(reported_address="456 Hotel Circle South", location_unit=None))
    assert saved["location_confirmation"] == {"location": OTHER, "evidence": "Yes"}
    assert result.location_confirmed is True


@pytest.mark.asyncio
async def test_plain_no_asks_for_the_correct_address(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "No.", unconfirmed())
    assert saved["location_confirmation"] is None
    assert result.next_question == CORRECT_ADDRESS


# 3. Silence or an unclear response.
@pytest.mark.parametrize("said", ["Um, I think so?", "Uh...", "Yes? I'm not sure", "Yeah, wait", "maybe", "Okay"])
def test_unclear_answers_are_not_a_yes(said):
    assert location_check.answer(said) != "yes"


@pytest.mark.parametrize("said", ["Yes", "yeah that's right", "Correct.", "Um, yes", "That's it", "Yep, please hurry"])
def test_plain_yes_is_a_yes(said):
    assert location_check.answer(said) == "yes"


@pytest.mark.asyncio
async def test_unclear_answer_rereads_once_then_lets_the_call_continue_unconfirmed(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "Um, I think so?", unconfirmed())
    assert saved["location_confirmation"] is None
    assert result.next_question == readback(HOME)

    heard += ["Caller: Um, I think so?", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "I can't really hear you", unconfirmed())
    assert saved["location_confirmation"] is None and result.location_confirmed is False
    assert result.next_question == NEXT  # read back twice: move on, still unconfirmed


@pytest.mark.asyncio
async def test_silence_after_read_back_confirms_nothing(turn):
    # The caller said nothing; the next saved line is the agent's own (an update played).
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}"]
    assert location_check.reply_to(heard, readback(HOME)) is None
    with pytest.raises(ValueError):
        Utterance(speaker="caller", text="   ")  # no words, no turn
    heard.append("Agent: I've passed your details to the dispatcher. Stay on the line with me.")
    result, saved = await turn(heard, "Yes", unconfirmed())
    assert saved["location_confirmation"] is None and result.location_confirmed is False


# 4. An unrelated "yes".
@pytest.mark.asyncio
async def test_yes_to_another_question_does_not_confirm(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}", "Caller: The water is coming in",
             "Agent: Is anyone hurt?"]
    result, saved = await turn(heard, "Yes", unconfirmed())
    assert saved["location_confirmation"] is None and result.location_confirmed is False


@pytest.mark.asyncio
async def test_yes_to_a_read_back_of_another_location_does_not_confirm(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(OTHER)}"]
    result, saved = await turn(heard, "Yes", unconfirmed())
    assert saved["location_confirmation"] is None


@pytest.mark.asyncio
async def test_yes_with_a_change_in_the_same_turn_is_not_a_confirmation(turn):
    heard = ["Caller: 1234 Hotel Circle North", f"Agent: {readback(HOME)}"]
    result, saved = await turn(heard, "Yes, apartment 6", unconfirmed(), facts(location_unit="apartment 6"))
    assert saved["location_confirmation"] is None
    assert result.next_question == readback("1234 Hotel Circle North, apartment 6, San Diego")


# 5. A correction after previous confirmation.
@pytest.mark.asyncio
async def test_correction_after_confirmation_needs_confirming_again(turn):
    heard = [f"Agent: {readback(HOME)}", "Caller: Yes", f"Agent: {NEXT}"]
    result, saved = await turn(heard, "Sorry, actually we're at 456 Hotel Circle South", confirmed(), facts(
        reported_address="456 Hotel Circle South", location_unit=None, location_changed=True))
    assert saved["reported_address"] == OTHER and saved["location_changed"] is True
    assert saved["location_confirmation"] is None and result.location_confirmed is False
    assert result.next_question == readback(OTHER)


# 6. Ambiguous geocoding or a wrong-city result.
def hit(name, lat, lon, city="San Diego", number=None):
    return {"category": "amenity", "type": "cafe", "lat": str(lat), "lon": str(lon),
            "display_name": f"{name}, Hotel Circle North, Mission Valley West, {city}, California",
            "address": {"house_number": number} if number else {}}


def test_geocode_reports_ambiguity_and_conflicts_instead_of_choosing():
    two = [hit("Starbucks", 32.7600, -117.1600), hit("Starbucks", 32.7700, -117.1500)]
    assert geocode._pick(two, "q", None, None).issue == "ambiguous"
    same_building = [hit("Handlery", 32.7600, -117.1600), hit("Handlery", 32.7601, -117.1601)]
    assert geocode._pick(same_building, "q", None, None).issue is None
    wrong_city = geocode._pick([hit("Starbucks", 32.76, -117.16)], "q", "La Mesa", None)
    assert wrong_city.issue == "conflict" and "La Mesa" in wrong_city.note
    wrong_number = geocode._pick([hit("Home", 32.76, -117.16, number="1243")], "q", "San Diego", "1234")
    assert wrong_number.issue == "conflict"


@pytest.mark.asyncio
async def test_find_candidate_passes_the_callers_city_and_house_number(monkeypatch):
    monkeypatch.setattr(geocode, "_search", AsyncMock(return_value=[hit("Home", 32.76, -117.16, number="99")]))
    match = await geocode.find_candidate(["q"], "San Diego", "1234 Hotel Circle North")
    assert match.issue == "conflict" and "1234" in match.note


@pytest.mark.asyncio
async def test_ambiguous_map_match_is_not_pinned_and_the_caller_is_asked(turn):
    match = Candidate(32.76, -117.16, "Starbucks", "q", issue="ambiguous", note="2 map matches far apart: Starbucks, Starbucks")
    result, saved = await turn([], "The Starbucks", extraction=facts(
        reported_address="the Starbucks", location_unit=None, location_city=None), match=match)
    assert saved["candidate"] is None and result.location_match is None
    assert saved["map_issue"] == match.note
    assert result.next_question.startswith("I found more than one place matching the Starbucks.")


@pytest.mark.asyncio
async def test_wrong_city_after_confirmation_asks_to_clarify_without_unconfirming(turn):
    match = Candidate(32.76, -117.16, "Main Street", "q", issue="conflict", note="Map match Main Street is not in La Mesa")
    place = "12 Main Street, La Mesa"
    heard = [f"Agent: {readback(place)}", "Caller: Yes", f"Agent: {NEXT}"]
    result, saved = await turn(heard, "Two of us", confirmed(place), facts(
        reported_address="12 Main Street", location_unit=None, location_city="La Mesa"), match=match)
    assert result.location_confirmed is True and saved["candidate"] is None
    assert result.next_question == f"I couldn't match {place} in La Mesa on the map. Can you give me a nearby cross street or landmark?"


# 7. Background extraction attempting to overwrite a confirmed address.
@pytest.mark.asyncio
async def test_rewording_keeps_the_confirmed_words(turn):
    heard = [f"Agent: {readback(HOME)}", "Caller: Yes", f"Agent: {NEXT}"]
    result, saved = await turn(heard, "Three of us", confirmed(), facts(reported_address="1234 hotel circle north."))
    assert saved["reported_address"] == HOME and result.location_confirmed is True
    assert result.next_question == NEXT


@pytest.mark.asyncio
async def test_unasked_location_change_is_read_back_not_applied(turn):
    heard = [f"Agent: {readback(HOME)}", "Caller: Yes", f"Agent: {NEXT}"]
    result, saved = await turn(heard, "Three of us", confirmed(), facts(
        reported_address="1234 Hotel Circle South", location_changed=False))
    # Sent for Convex to hold as unconfirmed (it never replaces the confirmed address).
    assert saved["reported_address"] == "1234 Hotel Circle South, apartment 5, San Diego"
    assert saved["location_confirmation"] is None and result.location_confirmed is False
    assert result.next_question == readback("1234 Hotel Circle South, apartment 5, San Diego")
