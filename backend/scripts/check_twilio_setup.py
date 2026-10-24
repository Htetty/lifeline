"""Check Twilio access and HTTPS/WSS readiness without changing number routing.

Stores optional routing backup privately. Never prints credentials or TwiML leases.
"""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import uuid
from xml.etree import ElementTree

import httpx
from twilio.http.http_client import TwilioHttpClient
from twilio.request_validator import RequestValidator
from twilio.rest import Client
import websockets

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.voice_provider import voice_environment


async def main(args):
    env=voice_environment()
    required=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER']
    if args.public: required.append('TWILIO_PUBLIC_BASE_URL')
    missing=[name for name in required if not env.get(name)]
    if missing: raise RuntimeError('Missing local variables: '+', '.join(missing))
    client=Client(env['TWILIO_ACCOUNT_SID'],env['TWILIO_AUTH_TOKEN'],http_client=TwilioHttpClient(timeout=15))
    numbers=await asyncio.to_thread(client.incoming_phone_numbers.list,phone_number=env['TWILIO_PHONE_NUMBER'],limit=2)
    if len(numbers)!=1: raise RuntimeError('Configured phone number was not found in this account')
    number=numbers[0]
    fields=('sid','voice_url','voice_method','voice_application_sid','trunk_sid',
            'voice_fallback_url','voice_fallback_method','status_callback','status_callback_method')
    snapshot={key:getattr(number,key,None) for key in fields}
    if args.backup_number:
        path=Path(args.backup_number)
        if path.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
            raise RuntimeError('Choose a private routing-backup path outside the Git workspace')
        # Never overwrite the pre-cutover snapshot with a post-cutover one.
        with path.open('x') as output:
            path.chmod(0o600);json.dump(snapshot,output,indent=2)
        print('Routing backup saved privately:',path)
    print('PASS: Twilio account access; configured number found')
    print('Existing number handler:', 'SIP trunk' if number.trunk_sid else 'TwiML application' if number.voice_application_sid else 'voice webhook')
    if not args.public: return
    base=env['TWILIO_PUBLIC_BASE_URL'].rstrip('/')
    if not base.startswith('https://'): raise RuntimeError('Public origin must use HTTPS')
    validator=RequestValidator(env['TWILIO_AUTH_TOKEN'])
    form={'AccountSid':env['TWILIO_ACCOUNT_SID'],'CallSid':'CA'+uuid.uuid4().hex,'To':env['TWILIO_PHONE_NUMBER']}
    headers={'X-Twilio-Signature':validator.compute_signature(base+'/twilio/voice',form)}
    async with httpx.AsyncClient(timeout=20) as http:
        assert (await http.get(base+'/health')).status_code==200
        assert (await http.post(base+'/twilio/voice',data=form)).status_code==403
        response=await http.post(base+'/twilio/voice',data=form,headers=headers)
        response.raise_for_status()
        xml=ElementTree.fromstring(response.text)
        stream=xml.find('Connect/Stream')
        assert stream is not None and stream.attrib['url']==base.replace('https:','wss:')+'/twilio/media'
        assert xml.find('Hangup') is not None
    print('PASS: public health, rejection of unsigned webhook, signed TwiML with WSS stream')
    ws_headers={'X-Twilio-Signature':validator.compute_signature(base+'/twilio/media',{})}
    async with websockets.connect(base.replace('https:','wss:')+'/twilio/media',additional_headers=ws_headers) as ws:
        # Deliberately invalid start must fail closed before provider audio/db work.
        await ws.send(json.dumps({'event':'start','start':{}}))
        try: await asyncio.wait_for(ws.recv(),10)
        except websockets.ConnectionClosed as exc:
            assert exc.code==4403
    print('PASS: public signed WSS handshake; invalid call identity rejected')
    print('NOT VERIFIED: actual Twilio signatures/audio, microphone, human hearing, assignment or hangup')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public',action='store_true')
    parser.add_argument('--backup-number',help='New private JSON path for exact routing rollback')
    try: asyncio.run(main(parser.parse_args()))
    except Exception as exc:
        print(str(exc) if isinstance(exc,RuntimeError) else f'Check failed: {type(exc).__name__}; provider body withheld',file=sys.stderr)
        raise SystemExit(1)
