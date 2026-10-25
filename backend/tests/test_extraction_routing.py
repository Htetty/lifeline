"""Merged voice context and simulation model routing reach the same extraction call."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import calls, convex_store, extraction


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["live_demo", "simulation"])
@pytest.mark.parametrize("level,depth", [("present", None), ("estimated", 0.75)])
async def test_model_routing_preserves_location_context_and_water_reports(monkeypatch, source, level, depth):
    settings = replace(extraction.settings, claude_model="claude-sonnet-5-5", sim_claude_model="claude-haiku-5-5")
    monkeypatch.setattr(calls, "settings", settings)
    monkeypatch.setattr(extraction, "settings", settings)
    monkeypatch.setattr(calls, "_transcripts", {})
    monkeypatch.setattr(calls, "_has_incident", set())
    monkeypatch.setattr(calls, "classify_text_async", None)
    monkeypatch.setattr(convex_store, "transcript_for_call", AsyncMock(return_value=None))
    monkeypatch.setattr(convex_store, "recorded_hazards", AsyncMock(return_value=[]))
    save = AsyncMock(return_value={"version": 1})
    monkeypatch.setattr(convex_store, "upsert_from_call", save)
    geocode = AsyncMock(return_value=None)
    monkeypatch.setattr(calls, "find_candidate", geocode)
    facts = extraction.Extraction(
        caller_role="trapped", reported_address=None, people_count=4, reported_position="roof",
        location_queries=["Fashion Valley Mall, San Diego, CA"], location_changed=False,
        hazards=[], risk_factors=[], summary="Four people on the roof", missing=[],
        caller_asked_status=False, next_question=None,
        reply="I've received the location you shared. Is anyone hurt?",
        water_report={"level": level, "measured_meters": depth, "floor": 0, "evidence": "the lobby is flooded"},
    )
    parse = AsyncMock(return_value=SimpleNamespace(stop_reason="end_turn", parsed_output=facts))
    monkeypatch.setattr(extraction.client.messages, "parse", parse)
    state = "Location received from this phone; it has not been verified by the dispatcher."
    result = await calls.process_utterance(
        f"routing-{source}-{level}",
        calls.Utterance(speaker="caller", text="Four of us on the roof; the lobby is flooded.", source=source),
        conversation_state=state,
    )

    assert result.saved and result.extraction_error is None
    assert result.reply == result.next_question == facts.reply
    request = parse.call_args.kwargs
    expected_model = settings.sim_claude_model if source == "simulation" else settings.claude_model
    assert request["model"] == expected_model
    assert f"<conversation_state>\n{state}\n</conversation_state>" in request["messages"][0]["content"]
    assert ("extra_headers" in request) == (source != "simulation")
    assert ("extra_body" in request) == (source != "simulation")
    assert save.call_args.args[1] == source
    assert save.call_args.kwargs["water_report"] == facts.water_report.model_dump()
    if source == "simulation":
        geocode.assert_not_awaited()
    else:
        geocode.assert_awaited_once_with(facts.location_queries)
