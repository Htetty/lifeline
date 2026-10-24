import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient
from twilio.request_validator import RequestValidator

from app import main, twilio_media as phone
from app.voice import Playback, Session

BASE = "https://voice.example.com"
ACCOUNT = "AC" + "a" * 32
CALL = "CA" + "b" * 32
STREAM = "MZ" + "c" * 32
TOKEN = "fixture-signing-token"
FORM = {"AccountSid":ACCOUNT, "CallSid":CALL, "To":"+15555550123", "From":"+15555550124"}


def signature(path, form=None):
    return {"X-Twilio-Signature":RequestValidator(TOKEN).compute_signature(BASE+path, form or {})}


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    monkeypatch.setattr(phone,"voice_environment",lambda: {
        "TWILIO_ACCOUNT_SID":ACCOUNT,"TWILIO_AUTH_TOKEN":TOKEN,
        "TWILIO_PHONE_NUMBER":FORM["To"],"TWILIO_PUBLIC_BASE_URL":BASE})
    phone._leases.clear();phone._active_calls.clear()
    yield
    phone._leases.clear();phone._active_calls.clear()


def webhook(client, form=FORM):
    return client.post(phone.VOICE_PATH,data=form,headers=signature(phone.VOICE_PATH,form))


def start(token, call=CALL):
    return {"event":"start","sequenceNumber":"1","streamSid":STREAM,"start":{
        "callSid":call,"accountSid":ACCOUNT,"streamSid":STREAM,
        "mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1},
        "customParameters":{"lease":token}}}


def test_webhook_signature_twiml_retry_and_identity():
    with TestClient(main.app) as client:
        assert client.post(phone.VOICE_PATH,data=FORM).status_code==403
        first=webhook(client)
        assert first.status_code==200
        root=ElementTree.fromstring(first.text)
        assert root.find('Connect/Stream').attrib['url']==BASE.replace('https:','wss:')+phone.MEDIA_PATH
        assert root.find('Hangup') is not None
        assert webhook(client).text==first.text
        assert webhook(client,{**FORM,"AccountSid":"AC"+'d'*32}).status_code==403
        assert webhook(client,{**FORM,"To":"+15555559999"}).status_code==403
        assert client.post(phone.VOICE_PATH+'?fake=1',data=FORM,headers=signature(phone.VOICE_PATH,FORM)).status_code==400


def test_signed_stream_binds_call_and_native_codec_once(monkeypatch):
    captured=[]
    class SharedSession:
        def __init__(self,call,speech,send): self.call_id=call
        async def run(self,transport,rate): captured.append((self.call_id,self.turn_prefix,self.audio_frame_alignment,rate))
    speech=object()
    factory=lambda **kwargs: captured.append(kwargs) or speech
    monkeypatch.setattr(phone,"Session",SharedSession)
    monkeypatch.setattr(phone,"CartesiaSpeech",factory)
    with TestClient(main.app) as client:
        token=ElementTree.fromstring(webhook(client).text).find('Connect/Stream/Parameter').attrib['value']
        with pytest.raises(Exception):
            with client.websocket_connect(phone.MEDIA_PATH): pass
        with client.websocket_connect(phone.MEDIA_PATH,headers=signature(phone.MEDIA_PATH)) as ws:
            ws.send_json({"event":"connected","protocol":"Call","version":"1.0.0"})
            ws.send_json(start(token))
            with pytest.raises(Exception): ws.receive_json()
        assert captured==[{'input_encoding':'pcm_mulaw','output_format':{'container':'raw','encoding':'pcm_mulaw','sample_rate':8000}},(CALL,STREAM,1,8000)]
        with client.websocket_connect(phone.MEDIA_PATH,headers=signature(phone.MEDIA_PATH)) as ws:
            ws.send_json(start(token))
            with pytest.raises(Exception): ws.receive_json()
        assert len(captured)==2


@pytest.mark.parametrize('mutate',[
    lambda s:s['start'].update(callSid='CA'+'d'*32),
    lambda s:s['start'].update(accountSid='AC'+'d'*32),
    lambda s:s['start']['customParameters'].update(lease='wrong'),
    lambda s:s['start']['mediaFormat'].update(sampleRate=16000),
])
def test_stream_rejects_forged_identity_and_format(mutate,monkeypatch):
    factory=AsyncMock();monkeypatch.setattr(phone,'CartesiaSpeech',factory)
    with TestClient(main.app) as client:
        webhook(client)
        data=start(phone._leases[CALL].token);mutate(data)
        with client.websocket_connect(phone.MEDIA_PATH,headers=signature(phone.MEDIA_PATH)) as ws:
            ws.send_json(data)
            with pytest.raises(Exception): ws.receive_json()
    factory.assert_not_called()


@pytest.fixture
def transport():
    return phone.TwilioTransport(SimpleNamespace(send_json=AsyncMock(),close=AsyncMock()),CALL,STREAM,1)


@pytest.mark.asyncio
async def test_mulaw_output_and_natural_mark_ack(transport,monkeypatch):
    audio=base64.b64encode(bytes([255])*1601).decode()
    session=Session(CALL,SimpleNamespace(synthesize=AsyncMock(return_value=bytes([255])*1601)),transport.send)
    ack=AsyncMock(return_value={"acknowledged":True})
    monkeypatch.setattr(phone.Session,'current',AsyncMock(return_value=True))
    monkeypatch.setattr(main.convex_store,'mark_announced',ack)
    await session.offer('approved team','event')
    name=session.playback.id
    ready=await transport.inbox.get()
    await session.playback_event(**{'kind':json.loads(ready['text'])['type'],'playback_id':name})
    wire=[c.args[0] for c in transport.socket.send_json.await_args_list]
    raw=b''.join(base64.b64decode(m['media']['payload']) for m in wire if m['event']=='media')
    assert raw==bytes([255])*1601 and wire[-1]['mark']['name']==name
    ack.assert_not_awaited()
    transport.socket.receive_json=AsyncMock(side_effect=[
        {'event':'mark','sequenceNumber':'2','streamSid':STREAM,'mark':{'name':name}},
        {'event':'mark','sequenceNumber':'3','streamSid':STREAM,'mark':{'name':name}},
        {'event':'stop','sequenceNumber':'4','streamSid':STREAM,'stop':{'callSid':CALL}},
    ])
    await transport.pump()
    complete=json.loads((await transport.inbox.get())['text'])
    await session.playback_event(complete['type'],complete['playback_id'])
    assert (await transport.inbox.get())['type']=='websocket.disconnect'
    ack.assert_awaited_once_with(CALL,'event')


@pytest.mark.asyncio
async def test_marks_after_clear_never_ack_and_update_stays_pending(transport,monkeypatch):
    ack=AsyncMock();monkeypatch.setattr(main.convex_store,'mark_announced',ack)
    session=Session(CALL,None,transport.send)
    session.playback=Playback('old','approved team','event','playing')
    transport.marks['old']='pending'
    await session.provider_event({'type':'turn.start'})
    assert transport.marks['old']=='cleared'
    assert transport.socket.send_json.await_args.args[0]['event']=='clear'
    transport.socket.receive_json=AsyncMock(side_effect=[
        {'event':'mark','sequenceNumber':'2','streamSid':STREAM,'mark':{'name':'old'}},
        {'event':'stop','sequenceNumber':'3','streamSid':STREAM,'stop':{'callSid':CALL}},
    ])
    await transport.pump()
    assert (await transport.inbox.get())['type']=='websocket.disconnect'
    assert session.playback is None and 'event' not in session.acknowledged
    ack.assert_not_awaited()


@pytest.mark.asyncio
async def test_clear_invalidates_before_network_write(transport):
    entered=asyncio.Event();release=asyncio.Event()
    async def slow_send(data): entered.set();await release.wait()
    transport.socket.send_json=slow_send
    transport.marks['old']='pending'
    task=asyncio.create_task(transport.send({'type':'audio_stop','playback_id':'old'}))
    try:
        await entered.wait()
        assert transport.marks['old']=='cleared'
    finally:
        release.set();await task


@pytest.mark.asyncio
async def test_duplicate_audio_and_stream_isolation(transport):
    media={'event':'media','sequenceNumber':'2','streamSid':STREAM,'media':{'track':'inbound','payload':base64.b64encode(b'123').decode()}}
    transport.socket.receive_json=AsyncMock(side_effect=[media,media,{**media,'sequenceNumber':'3','streamSid':'wrong'}])
    await transport.pump()
    assert (await transport.inbox.get())['bytes']==b'123'
    assert (await transport.inbox.get())['type']=='websocket.disconnect'


@pytest.mark.asyncio
async def test_disconnect_cleanup_when_input_queue_is_full(transport):
    transport.inbox=asyncio.Queue(maxsize=1)
    await transport.inbox.put({})
    transport.socket.receive_json=AsyncMock(return_value={'event':'media','sequenceNumber':'2','streamSid':STREAM,'media':{'track':'inbound','payload':'////'}})
    transport.reader=asyncio.create_task(transport.pump())
    await asyncio.sleep(0)
    await asyncio.wait_for(transport.close(),1)
    assert transport.reader.cancelled()


@pytest.mark.asyncio
async def test_stale_offer_sends_no_phone_audio(transport,monkeypatch):
    monkeypatch.setattr(phone.Session,'current',AsyncMock(return_value=False))
    session=Session(CALL,SimpleNamespace(synthesize=AsyncMock(return_value=b'raw')),transport.send)
    await session.offer('stale assignment','event')
    assert session.playback is None
    transport.socket.send_json.assert_not_awaited()


@pytest.mark.asyncio
async def test_audio_does_not_wait_for_playback_ack_storage(monkeypatch):
    from contextlib import asynccontextmanager
    entered,release,audio_sent,closed=asyncio.Event(),asyncio.Event(),asyncio.Event(),asyncio.Event()
    class Speech:
        async def configure(self): pass
        async def close(self): pass
        @asynccontextmanager
        async def listen(self,rate): yield self
        async def send_raw(self,audio): audio_sent.set()
        async def send(self,command): closed.set()
        def __aiter__(self): return self.events()
        async def events(self):
            await closed.wait()
            if False: yield None
    class Socket:
        count=0
        async def receive(self):
            self.count+=1
            if self.count==1: return {'type':'websocket.receive','text':json.dumps({'type':'playback_complete','playback_id':'p'})}
            if self.count==2:
                await entered.wait()
                return {'type':'websocket.receive','bytes':b'123'}
            await release.wait()
            return {'type':'websocket.disconnect'}
        send_json=AsyncMock();close=AsyncMock()
    async def slow_ack(*args): entered.set();await release.wait();return {'acknowledged':True}
    monkeypatch.setattr(main.convex_store,'mark_announced',slow_ack)
    monkeypatch.setattr(main.convex_store,'start_voice_call',AsyncMock(return_value={'nextSequence':1}))
    monkeypatch.setattr(main,'end_call',AsyncMock())
    monkeypatch.setattr(main,'process_utterance',AsyncMock(return_value=SimpleNamespace(incident={},extraction_error=None,next_question=None)))
    session=Session(CALL,Speech(),AsyncMock())
    session.audio_frame_alignment=1
    session.playback=Playback('p','approved','event','playing')
    run=asyncio.create_task(session.run(Socket(),8000))
    try:
        await asyncio.wait_for(audio_sent.wait(),1)
        assert not release.is_set()
        release.set()
        await asyncio.wait_for(run,2)
    finally:
        release.set();run.cancel();await asyncio.gather(run,return_exceptions=True)
