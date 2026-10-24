import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app import main, voice
from app.voice import Playback, Session


@pytest.fixture
def session():
    return Session("browser-fixture", SimpleNamespace(synthesize=AsyncMock(return_value=b"wav")), AsyncMock())


@pytest.mark.asyncio
async def test_only_final_provider_speech_and_duplicates(session):
    await session.provider_event({"type":"turn.update", "transcript":"partial"})
    await session.provider_event({"type":"turn.eager_end", "transcript":"not final"})
    assert session.queue.empty()
    await session.provider_event({"type":"turn.start"})
    await session.provider_event({"type":"turn.end", "transcript":"Three upstairs"})
    await session.provider_event({"type":"turn.end", "transcript":"Three upstairs"})
    assert session.queue.qsize() == 1
    assert (await session.queue.get())[:3] == ("ink-1", "caller", "Three upstairs")
    await session.provider_event({"type":"turn.start"})
    await session.provider_event({"type":"turn.end", "transcript":"Actually four"})
    assert (await session.queue.get())[0] == "ink-2"


@pytest.mark.asyncio
async def test_delayed_or_null_transcript_never_invents_words(session):
    await session.provider_event({"type":"turn.start"})
    await session.provider_event({"type":"turn.update","transcript":None})
    assert session.queue.empty()
    await session.provider_event({"type":"turn.end","transcript":None})
    assert session.queue.empty()
    await session.provider_event({"type":"turn.start"})
    await session.provider_event({"type":"turn.end","transcript":"Now speech is final"})
    assert (await session.queue.get())[2]=="Now speech is final"


@pytest.mark.asyncio
async def test_provider_error_ends_session_instead_of_silent_continuation(session):
    with pytest.raises(RuntimeError,match="STT failed"):
        await session.provider_event({"type":"error","message":"not logged"})


@pytest.mark.asyncio
async def test_new_speech_cancels_pending_synthesis(session):
    started=asyncio.Event()
    async def slow_speech(text):
        started.set()
        await asyncio.Event().wait()
    session.speech.synthesize=slow_speech
    session.speak("old follow-up")
    await started.wait()
    await session.provider_event({"type":"turn.start"})
    assert session.audio_task.cancelled() and session.playback is None


@pytest.mark.asyncio
async def test_audio_turns_continue_while_extraction_waits(session,monkeypatch):
    started,release=asyncio.Event(),asyncio.Event()
    async def slow_process(call_id,turn):
        started.set(); await release.wait()
        return SimpleNamespace(incident={},extraction_error=None,next_question="old follow-up")
    monkeypatch.setattr(main,"process_utterance",slow_process)
    await session.queue.put(("ink-1","caller","first",0))
    worker=asyncio.create_task(session.worker())
    try:
        await started.wait()
        await session.provider_event({"type":"turn.start"})
        await session.provider_event({"type":"turn.end","transcript":"second"})
        assert session.queue.qsize()==1 and session.processing
        release.set()
        await asyncio.wait_for(session.queue.join(),1)
        assert session.sequence==3
    finally:
        worker.cancel();await asyncio.gather(worker,return_exceptions=True)
        if session.audio_task:
            session.audio_task.cancel();await asyncio.gather(session.audio_task,return_exceptions=True)


@pytest.mark.asyncio
async def test_order_and_retry_identity(session, monkeypatch):
    seen=[]
    async def process(call_id, turn):
        seen.append((call_id,turn.turn_id,turn.sequence))
        if len(seen)==1: raise RuntimeError("lost response")
        return SimpleNamespace(incident={}, extraction_error=None, next_question=None)
    monkeypatch.setattr(main,"process_utterance",process)
    monkeypatch.setattr(voice.asyncio,"sleep",AsyncMock())
    await session.persist(("ink-1","caller","first",0))
    await session.persist(("ink-2","caller","second",0))
    assert seen == [(session.call_id,"ink-1",1)]*2 + [(session.call_id,"ink-2",2)]


@pytest.mark.asyncio
async def test_permanent_storage_failure_does_not_skip_turn(session,monkeypatch):
    process=AsyncMock(side_effect=RuntimeError("storage unavailable"))
    monkeypatch.setattr(main,"process_utterance",process)
    monkeypatch.setattr(voice.asyncio,"sleep",AsyncMock())
    await session.queue.put(("ink-1","caller","first",0))
    await session.queue.put(("ink-2","caller","second",0))
    with pytest.raises(RuntimeError): await session.worker()
    assert process.await_count==6
    assert all(call.args[1].sequence==1 for call in process.await_args_list)
    assert session.queue.qsize()==1 and session.failure


@pytest.mark.asyncio
async def test_lost_mutation_response_reuses_receipt(monkeypatch):
    receipt={}
    extract=AsyncMock(return_value=None)
    monkeypatch.setattr(main,"extract_incident",extract)
    monkeypatch.setattr(main.convex_store,"turn_receipt",AsyncMock(side_effect=lambda call,turn: receipt.get(turn["turnId"])))
    monkeypatch.setattr(main.convex_store,"transcript_for_call",AsyncMock(return_value=None))
    async def commit(call,source,transcript,**kwargs):
        receipt[kwargs['turn']['turnId']]={**kwargs['response'],"incident":{"incidentId":"one"}}
        raise RuntimeError("response lost AFTER commit")
    commit_mock=AsyncMock(side_effect=commit)
    monkeypatch.setattr(main.convex_store,"upsert_from_call",commit_mock)
    turn=main.Utterance(speaker="caller",text="Three upstairs",turn_id="ink-1",sequence=1)
    with pytest.raises(RuntimeError): await main.process_utterance("isolated",turn)
    result=await main.process_utterance("isolated",turn)
    assert result.incident['incidentId']=="one"
    assert extract.await_count==commit_mock.await_count==1


@pytest.mark.asyncio
async def test_extraction_failure_preserves_verified_words(monkeypatch):
    monkeypatch.setattr(main,"extract_incident",AsyncMock(side_effect=main.ExtractionUnavailable("test")))
    monkeypatch.setattr(main.convex_store,"turn_receipt",AsyncMock(return_value=None))
    monkeypatch.setattr(main.convex_store,"transcript_for_call",AsyncMock(return_value="Caller: Three upstairs"))
    async def commit(call,source,transcript,**kwargs):
        assert transcript=="Caller: Three upstairs\nCaller: Actually four"
        assert kwargs.get('people_count') is None
        return {**kwargs['response'],"incident":{"incidentId":"same"}}
    monkeypatch.setattr(main.convex_store,"upsert_from_call",commit)
    result=await main.process_utterance("failed-extraction",main.Utterance(speaker="caller",text="Actually four",turn_id="ink-2",sequence=2))
    assert result.extraction_error and not result.extraction and not result.next_question


@pytest.mark.asyncio
async def test_stale_announcement_not_started(session,monkeypatch):
    monkeypatch.setattr(voice.convex_store,"pending_events",AsyncMock(return_value=[]))
    await session.offer("approved once","event-1")
    assert session.playback is None
    session.playback=Playback("p","approved once","event-1")
    await session.playback_event("playback_ready","p")
    assert session.playback is None
    assert not any(c.kwargs.get('type')=="audio_go" for c in session.send.await_args_list)


@pytest.mark.asyncio
async def test_interruption_keeps_event_unacknowledged(session,monkeypatch):
    ack=AsyncMock()
    monkeypatch.setattr(voice.convex_store,"mark_announced",ack)
    session.playback=Playback("p","approved","event-1","playing")
    await session.provider_event({"type":"turn.start"})
    await session.playback_event("playback_complete","p")
    ack.assert_not_awaited()
    assert session.playback is None


@pytest.mark.asyncio
async def test_completed_ack_retry_does_not_replay(session,monkeypatch):
    ack=AsyncMock(side_effect=[RuntimeError("lost ack response"),{"acknowledged":True}])
    monkeypatch.setattr(voice.convex_store,"mark_announced",ack)
    p=Playback("p","approved","event-1","playing")
    session.playback=p
    with pytest.raises(RuntimeError): await session.playback_event("playback_complete","p")
    assert p.phase=="completed" and session.playback is p
    assert not session.speak("approved","event-1")
    await session.complete(p)
    await session.complete(p)
    assert session.queue.qsize()==1 and ack.await_count==2
    assert "event-1" in session.acknowledged


@pytest.mark.asyncio
async def test_processing_blocks_announcement_ready(session):
    session.processing=True
    session.playback=Playback("p","old assignment","old")
    await session.playback_event("playback_ready","p")
    assert session.playback is None


def test_auth_and_single_use_ticket():
    with TestClient(main.app) as client:
        assert client.post('/voice/sessions').status_code==401
        assert client.get('/calls/private/status').status_code==401
        assert client.post('/calls/private/utterances',json={"speaker":"caller","text":"x"}).status_code==401
        response=client.post('/voice/sessions',headers={"Authorization":"Bearer fixture-voice-token"})
        assert response.status_code==200
        ticket=response.json()['ticket']
        assert response.json()['call_id'].startswith('browser-')
        with client.websocket_connect('/voice/socket',subprotocols=[ticket],headers={"origin":"http://testserver"}) as ws:
            ws.send_json({"type":"start","sample_rate":1})
        with pytest.raises(Exception):
            with client.websocket_connect('/voice/socket',subprotocols=[ticket],headers={"origin":"http://testserver"}): pass
        other=client.post('/voice/sessions',headers={"Authorization":"Bearer fixture-voice-token"}).json()['ticket']
        with pytest.raises(Exception):
            with client.websocket_connect('/voice/socket',subprotocols=[other],headers={"origin":"https://untrusted.invalid"}): pass


@pytest.mark.asyncio
async def test_disconnect_drains_final_turn_and_cleans_tasks(monkeypatch):
    class STT:
        def __init__(self): self.done=asyncio.Event()
        async def send(self,msg): self.done.set()
        def __aiter__(self): return self.events()
        async def events(self):
            yield {"type":"turn.start"}
            await self.done.wait()
            yield {"type":"turn.end","transcript":"Final words at hangup"}
    from contextlib import asynccontextmanager
    stt=STT()
    class Speech:
        configure=AsyncMock(); close=AsyncMock(); synthesize=AsyncMock(return_value=b'audio')
        @asynccontextmanager
        async def listen(self,rate): yield stt
    socket=SimpleNamespace(receive=AsyncMock(return_value={"type":"websocket.disconnect"}),send_json=AsyncMock(),close=AsyncMock())
    monkeypatch.setattr(voice.convex_store,"start_voice_call",AsyncMock(return_value={"nextSequence":1}))
    monkeypatch.setattr(voice.convex_store,"pending_events",AsyncMock(return_value=[]))
    ended=AsyncMock(); monkeypatch.setattr(main,"end_call",ended)
    process=AsyncMock(return_value=SimpleNamespace(incident={},extraction_error=None,next_question=None))
    monkeypatch.setattr(main,"process_utterance",process)
    s=Session('drain',Speech(),socket.send_json)
    before=set(asyncio.all_tasks())
    await s.run(socket,48000)
    assert process.await_args.args[1].text=="Final words at hangup"
    ended.assert_awaited_once_with('drain')
    s.speech.close.assert_awaited_once()
    assert not [task for task in asyncio.all_tasks()-before if not task.done()]
