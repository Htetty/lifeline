"""Caller turns that pile up while extraction runs: all saved, extracted once, no stale questions."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # unittest discovery has no conftest
from app import main  # noqa: E402
from app.voice import Session  # noqa: E402

EXTRACT_S = 0.05  # stands in for ~2.5 s of Claude extraction


def session_with(calls, questions=None, fail_first=False):
    """A Session whose processing records (sequence, text, options) and answers with a question."""
    questions = questions or {}
    state = {"failed": not fail_first}

    async def process(call_id, utterance, **options):
        if not state["failed"]:
            state["failed"] = True
            raise OSError("fixture storage failure")
        calls.append((utterance.sequence, utterance.text, options))
        if options.get("extract", True):
            await asyncio.sleep(EXTRACT_S)
        return SimpleNamespace(incident={}, extraction_error=None,
                               next_question=None if options.get("extract") is False else questions.get(utterance.text))

    s = Session("call", SimpleNamespace(synthesize=AsyncMock(return_value=b"audio")), AsyncMock())
    s.speak = lambda text, *a, **k: s.spoken.append(text) or True
    s.spoken = []
    return s, process


async def caller(s, text):
    s.turn_number += 1
    s.open_turn = True
    await s.provider_event({"type": "turn.end", "transcript": text})


async def drain(s):
    worker = asyncio.create_task(s.worker())
    try:
        await asyncio.wait_for(s.queue.join(), 5)
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)


@pytest.mark.asyncio
async def test_queued_turns_are_all_saved_in_order_and_extracted_once(monkeypatch):
    calls = []
    s, process = session_with(calls, {"third": "Q3"})
    monkeypatch.setattr(main, "process_utterance", process)
    for text in ("first", "second", "third"):
        await caller(s, text)
    await drain(s)
    assert [(seq, text) for seq, text, _ in calls] == [(1, "first"), (2, "second"), (3, "third")]
    assert [o for _, _, o in calls] == [{"extract": False}, {"extract": False},
                                        {"latest_message": "first\nsecond\nthird"}]
    assert s.spoken == ["Q3"] and s.unextracted == []


@pytest.mark.asyncio
async def test_turns_arriving_during_extraction_skip_the_stale_question(monkeypatch):
    calls = []
    s, process = session_with(calls, {"we are on the roof": "Q1 how many?", "two of us": "Q3 anyone hurt?"})
    monkeypatch.setattr(main, "process_utterance", process)
    worker = asyncio.create_task(s.worker())
    try:
        await caller(s, "we are on the roof")
        await asyncio.sleep(EXTRACT_S / 3)  # caller keeps talking while turn 1 is extracted
        await caller(s, "sorry, the attic")
        await caller(s, "two of us")
        await asyncio.wait_for(s.queue.join(), 5)
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
    assert [o for _, _, o in calls] == [{}, {"extract": False}, {"latest_message": "sorry, the attic\ntwo of us"}]
    # Q1 was generated before the correction and the count arrived: never spoken.
    assert s.spoken == ["Q3 anyone hurt?"]


@pytest.mark.asyncio
async def test_single_turns_keep_the_original_flow(monkeypatch):
    calls = []
    s, process = session_with(calls, {"hello": "Where are you?"})
    monkeypatch.setattr(main, "process_utterance", process)
    await caller(s, "hello")
    await drain(s)
    assert calls == [(1, "hello", {})] and s.spoken == ["Where are you?"]


@pytest.mark.asyncio
async def test_retry_after_failed_save_keeps_the_plan_and_loses_no_text(monkeypatch):
    calls = []
    s, process = session_with(calls, {"b": "Qb"}, fail_first=True)
    monkeypatch.setattr(main, "process_utterance", process)
    monkeypatch.setattr("app.voice.asyncio.sleep", AsyncMock())  # skip retry back-off
    await caller(s, "a")
    await caller(s, "b")
    await drain(s)
    assert [(seq, t, o) for seq, t, o in calls] == [(1, "a", {"extract": False}), (2, "b", {"latest_message": "a\nb"})]
    assert s.spoken == ["Qb"]


@pytest.mark.asyncio
async def test_agent_lines_never_count_as_newer_caller_turns(monkeypatch):
    calls = []
    s, process = session_with(calls, {"we are upstairs": "How many?"})
    monkeypatch.setattr(main, "process_utterance", process)
    await caller(s, "we are upstairs")
    await s.queue.put(("spoken-1", "agent", "Thank you.", s.generation))  # agent line queued behind
    await drain(s)
    assert calls[0] == (1, "we are upstairs", {})  # still extracted: only caller turns supersede
