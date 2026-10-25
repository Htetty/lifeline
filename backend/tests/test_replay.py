"""Regression cases from the failed real phone replay, not synthetic success claims."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app import main, voice
from app.voice import Playback, Session, QUIET_SECONDS


# Dev saves the approved, role-aware wording on each update; the phone speaks that text.
EVENT={'_id':'approved-event','type':'assignment_approved','teamName':'Swift Water Boat 1','announcedAt':100,
       'text':'Update from the dispatcher: a rescue team, Swift Water Boat 1, has been assigned to you.'}
STAGE='The dispatcher has confirmed your location and is arranging a rescue team. No team has been assigned yet.'


@pytest.fixture
def session(monkeypatch):
    monkeypatch.setattr(main.convex_store,'pending_events',AsyncMock(return_value=[]))
    monkeypatch.setattr(main.convex_store,'current_announcement',AsyncMock(return_value=EVENT))
    monkeypatch.setattr(main.convex_store,'call_state',AsyncMock(return_value={'status':{'sayIfAsked':STAGE},'pending':[]}))
    s=Session('call',SimpleNamespace(synthesize=AsyncMock(return_value=b'audio')),AsyncMock())
    s.last_speech=0
    return s


@pytest.mark.asyncio
async def test_completed_assignment_replays_only_on_request_and_survives_interruption(session,monkeypatch):
    ack=AsyncMock();monkeypatch.setattr(main.convex_store,'mark_announced',ack)
    session.acknowledged.add(EVENT['_id'])
    session.last_audible=Playback('original','original assignment',EVENT['_id'],'completed')
    assert session.repeat_request('Wait, sorry, can you repeat that?','ink-4')
    await session.poll_once();await session.audio_task
    first=session.playback
    assert first.replay and first.event_id==EVENT['_id']
    await session.playback_event('playback_ready',first.id)
    await session.interrupt()
    assert session.requested_repeat is not None
    await session.poll_once();await session.audio_task
    replay=session.playback
    assert replay.id!=first.id and 'Swift Water Boat 1' in replay.text
    await session.playback_event('playback_ready',replay.id)
    await session.playback_event('playback_complete',replay.id)
    assert session.requested_repeat is None
    ack.assert_not_awaited() # already acked; explicit replay doesn't mutate/requeue delivery
    assert session.queue.qsize()==1
    session.queue.get_nowait();session.queue.task_done()
    session.last_output_end=0
    await session.poll_once()
    assert session.speech.synthesize.await_count==2 # no automatic repeat after completion


@pytest.mark.asyncio
async def test_real_repeat_utterance_does_not_trigger_an_injury_question(session):
    session.last_audible=Playback('original','assignment',EVENT['_id'],'completed')
    session.persist=AsyncMock(return_value=SimpleNamespace(incident={},extraction=None, extraction_error=None,reply='Is anyone hurt or in need of medical help?'))
    await session.queue.put(('ink-4','caller','Wait, sorry, can you repeat that?',0))
    worker=asyncio.create_task(session.worker())
    try:
        await session.queue.join()
        assert session.requested_repeat['kind']=='announcement'
        assert session.audio_task is None
    finally:
        worker.cancel();await asyncio.gather(worker,return_exceptions=True)
    session.last_audible=Playback('question','Is anyone hurt?',None,'completed')
    assert session.repeat_request('Yo, I thought you mentioned something about a team. What happened to the team?','ink-10')
    assert session.requested_repeat['kind']=='announcement'


@pytest.mark.asyncio
async def test_current_question_is_not_preempted_and_completion_has_a_response_pause(session,monkeypatch):
    pending=AsyncMock(return_value=[{'eventId':'approved-event','text':'approved assignment'}])
    monkeypatch.setattr(main,'announcements',pending)
    monkeypatch.setattr(main.convex_store,'pending_events',AsyncMock(return_value=[EVENT]))
    question=Playback('question','Is anyone hurt?',None,'playing')
    session.playback=question
    await session.poll_once()
    assert session.playback is question
    assert not session.speak('approved assignment',EVENT['_id'])
    await session.playback_event('playback_complete',question.id)
    session.queue.get_nowait();session.queue.task_done()
    await session.poll_once()
    assert session.audio_task is None
    session.last_output_end=time.monotonic()-QUIET_SECONDS-.1
    await session.poll_once();await session.audio_task
    assert session.playback.event_id==EVENT['_id']


@pytest.mark.asyncio
async def test_synthesis_reserves_output_and_pending_assignment_suppresses_unsent_question(session,monkeypatch):
    started,release=asyncio.Event(),asyncio.Event()
    async def synthesize(text): started.set();await release.wait();return b'audio'
    session.speech.synthesize=synthesize
    monkeypatch.setattr(main.convex_store,'pending_events',AsyncMock(return_value=[EVENT]))
    session.speak('Is anyone hurt?')
    await started.wait()
    assert session.playback.phase=='synthesizing'
    assert not session.speak('assignment',EVENT['_id'])
    release.set();await session.audio_task
    assert session.playback is None
    session.send.assert_not_awaited() # no question began; nothing was cut/cleared


@pytest.mark.asyncio
async def test_withdrawn_assignment_cannot_be_replayed(session,monkeypatch):
    session.requested_repeat={'kind':'announcement','id':'repeat','event_id':EVENT['_id']}
    current=AsyncMock(return_value=None)
    monkeypatch.setattr(main.convex_store,'current_announcement',current)
    await session.poll_once();await session.audio_task
    current.assert_awaited_once_with('call',EVENT['_id'])  # that exact update, checked for currency
    assert session.requested_repeat is None
    assert session.playback.event_id is None
    # Dev's truthful confirmed stage instead of the withdrawn team; never the old update.
    assert session.playback.text==STAGE and 'Swift Water Boat 1' not in session.playback.text


@pytest.mark.asyncio
async def test_repeat_question_uses_last_played_question_not_an_assignment(session):
    session.last_audible=Playback('question','Is anyone hurt?',None,'completed')
    session.repeat_request('Can you say that again?','request')
    await session.poll_once();await session.audio_task
    assert session.playback.text=='Is anyone hurt?' and session.playback.event_id is None
