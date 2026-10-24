"""Real local Convex + signed phone protocol; speech, Claude and playback mocked.

Run with scripts/integration/local_convex.sh, never against the shared deployment.
"""
import asyncio
import base64
from contextlib import asynccontextmanager
import time
import uuid
from unittest.mock import patch
from xml.etree import ElementTree

from test_integration import Base, facts
from app import twilio_media as phone
from twilio.request_validator import RequestValidator

ORIGIN = 'https://phone.example.test'
ACCOUNT = 'AC'+'a'*32
STREAM = 'MZ'+'c'*32
TOKEN = 'local-signing-fixture-only'
WORDS = ['Three upstairs at 123 Hotel Circle South in Mission Valley.',
         'Correction, four upstairs at 456 Hotel Circle North in Mission Valley.',
         'Wait, I am interrupting this simulated announcement.']


class ProviderFixture:
    def __init__(self,**kwargs):
        assert kwargs['input_encoding']=='pcm_mulaw'
        self.events=asyncio.Queue()
        self.turn=0
    async def configure(self): pass
    async def close(self): pass
    async def synthesize(self,text): return bytes([255])*2400
    @asynccontextmanager
    async def listen(self,rate):
        assert rate==8000
        yield self
    async def send_raw(self,audio):
        await self.events.put({'type':'turn.start'})
        await self.events.put({'type':'turn.end','transcript':WORDS[self.turn]})
        self.turn+=1
    async def send(self,command): await self.events.put(None)
    def __aiter__(self): return self.iterate()
    async def iterate(self):
        while True:
            event=await self.events.get()
            if event is None: return
            yield event


class PhoneFlow(Base):
    def test_signed_phone_correction_interrupt_ack_and_hangup(self):
        self.call='CA'+uuid.uuid4().hex
        env={'TWILIO_ACCOUNT_SID':ACCOUNT,'TWILIO_AUTH_TOKEN':TOKEN,
             'TWILIO_PHONE_NUMBER':'+15555550123','TWILIO_PUBLIC_BASE_URL':ORIGIN}
        self.enterContext(patch.object(phone,'voice_environment',return_value=env))
        self.enterContext(patch.object(phone,'CartesiaSpeech',ProviderFixture))
        form={'AccountSid':ACCOUNT,'CallSid':self.call,'To':env['TWILIO_PHONE_NUMBER']}
        def signed(path,params):
            return {'X-Twilio-Signature':RequestValidator(TOKEN).compute_signature(ORIGIN+path,params)}
        response=self.http.post(phone.VOICE_PATH,data=form,headers=signed(phone.VOICE_PATH,form))
        self.assertEqual(response.status_code,200)
        lease=ElementTree.fromstring(response.text).find('Connect/Stream/Parameter').attrib['value']
        self.extract(facts(reported_address='123 Hotel Circle South',next_question=None))
        def until(predicate):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                if predicate(): return
                time.sleep(.02)
            self.fail('Local phone workflow did not reach expected state')
        with self.http.websocket_connect(phone.MEDIA_PATH,headers=signed(phone.MEDIA_PATH,{})) as ws:
            ws.send_json({'event':'start','sequenceNumber':'1','streamSid':STREAM,'start':{
                'callSid':self.call,'accountSid':ACCOUNT,'streamSid':STREAM,
                'mediaFormat':{'encoding':'audio/x-mulaw','sampleRate':8000,'channels':1},
                'customParameters':{'lease':lease}}})
            sequence=1
            def send(kind,**payload):
                nonlocal sequence
                sequence+=1
                message={'event':kind,'sequenceNumber':str(sequence),'streamSid':STREAM,**payload}
                ws.send_json(message)
                return message
            def receive(kind):
                for _ in range(100):
                    message=ws.receive_json()
                    if message['event']==kind: return message
                self.fail('Expected phone output not received')
            greeting=receive('mark')['mark']
            send('mark',mark=greeting)
            media={'track':'inbound','payload':base64.b64encode(bytes([255])*160).decode()}
            duplicate=send('media',media=media)
            ws.send_json(duplicate)
            until(lambda:self.incident(missing_ok=True) is not None)
            original=self.incident()
            self.extract(facts(reported_address='456 Hotel Circle North',people_count=4,location_changed=True,next_question=None))
            send('media',media=media)
            until(lambda:self.incident()['peopleCount']==4)
            current=self.incident()
            self.assertEqual(original['_id'],current['_id'])
            self.assertEqual(current['transcript'].count('Caller:'),2)
            self.assertIn('123 Hotel Circle South',current['transcript'])
            self.assertIn('456 Hotel Circle North',current['transcript'])
            self.assertTrue(current['factHistory'])
            team=self.dispatch()
            first_assignment=receive('mark')['mark']
            self.assertEqual(len(self.announcements()),1)
            self.assertIn(team['name'],self.announcements()[0]['text'])
            self.extract(facts(reported_address='456 Hotel Circle North',people_count=4,next_question=None))
            send('media',media=media)
            receive('clear')
            send('mark',mark=first_assignment) # Twilio's clear-induced mark MUST NOT ack
            self.assertEqual(len(self.announcements()),1)
            second_assignment=receive('mark')['mark']
            self.assertNotEqual(first_assignment['name'],second_assignment['name'])
            send('mark',mark=second_assignment)
            until(lambda:not self.announcements())
            send('mark',mark=second_assignment) # repeated mark doesn't repeat persistence
            send('stop',stop={'callSid':self.call,'accountSid':ACCOUNT})
            try: ws.receive_json()
            except Exception: pass
        ended=self.incident()
        self.assertFalse(ended['callConnected'])
        self.assertEqual(ended['status'],'assigned')
        self.assertEqual(ended['_id'],original['_id'])
