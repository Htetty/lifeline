"""Synthetic full-bridge exercise, restricted to LOOPBACK Convex and FastAPI.

Uses live Cartesia + Claude and real local Convex. Playback messages are simulated,
so this does NOT verify a physical microphone, browser speaker, or human hearing.
Never resets data. Leaves the fictional incident available after ending.
"""
import argparse
import asyncio
import json
from pathlib import Path
import struct
import sys
from urllib.parse import urlsplit

import httpx
from convex import ConvexClient
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.voice_provider import CartesiaSpeech, voice_environment


async def main(args):
    for url in (args.api, args.convex_url):
        if urlsplit(url).hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("This exercise only permits loopback deployments")
    env = voice_environment()
    secret = Path(args.backend_secret_file).read_text().strip()
    db = ConvexClient(args.convex_url)
    async def mutation(name, **values):
        return await asyncio.to_thread(db.mutation, name, values)
    async def query(name, **values):
        return await asyncio.to_thread(db.query, name, values)
    await mutation("exercise:ensureSeeded")
    speech = CartesiaSpeech()
    async with httpx.AsyncClient(base_url=args.api) as http:
        response = await http.post('/voice/sessions', headers={"Authorization":f"Bearer {env['VOICE_BRIDGE_TOKEN']}"})
        response.raise_for_status()
        session = response.json()
    call_id = session['call_id']
    print("Synthetic exercise call:", call_id)
    url = args.api.replace('http://','ws://') + '/voice/socket'
    saved = asyncio.Queue()
    played = asyncio.Queue()
    frames = asyncio.Queue()
    playback_tasks = set()
    async with websockets.connect(url, origin=args.api, subprotocols=[session['ticket']], max_size=8*1024*1024) as ws:
        await ws.send(json.dumps({"type":"start","sample_rate":16000}))
        async def input_audio():
            while True:
                try: audio = frames.get_nowait()
                except asyncio.QueueEmpty: audio = bytes(3200)
                await ws.send(audio)
                await asyncio.sleep(.05)
        async def fake_playback(data):
            # Explicitly simulated completion, not an audible playback claim.
            await asyncio.sleep(.1)
            await ws.send(json.dumps({"type":"playback_complete","playback_id":data['playback_id']}))
            await played.put(data)
        offers = {}
        async def output_audio():
            async for message in ws:
                data = json.loads(message)
                if data['type']=='audio_offer':
                    offers[data['playback_id']]=data
                    await ws.send(json.dumps({"type":"playback_ready","playback_id":data['playback_id']}))
                elif data['type']=='audio_go':
                    task=asyncio.create_task(fake_playback(offers[data['playback_id']]))
                    playback_tasks.add(task);task.add_done_callback(playback_tasks.discard)
                elif data['type']=='transcript':
                    print('Provider-final caller speech received; characters:',len(data['text']))
                elif data['type']=='saved':
                    if data.get('extraction_error'): raise RuntimeError('Live Claude extraction failed')
                    await saved.put(data)
                elif data['type']=='fatal': raise RuntimeError('Bridge reported failure')
        sender=asyncio.create_task(input_audio())
        receiver=asyncio.create_task(output_audio())
        async def say(text):
            pcm=await speech.synthesize(text,raw=True)
            samples=struct.unpack(f'<{len(pcm)//2}h',pcm)
            audio=struct.pack(f'<{len(samples)}f',*(s/32768 for s in samples))
            for offset in range(0,len(audio),3200): await frames.put(audio[offset:offset+3200])
        async def wait_status(predicate, timeout=90):
            async with asyncio.timeout(timeout):
                while True:
                    if receiver.done(): receiver.result()
                    status=await query('calls:statusForCall',secret=secret,callId=call_id)
                    if status and predicate(status): return status
                    await asyncio.sleep(.5)
        try:
            await asyncio.wait_for(played.get(),30) # greeting
            await say('This is a fictional flood. Three people are upstairs at 123 Hotel Circle South in Mission Valley. Water is rising on the stairs.')
            first=await wait_status(lambda s: True)
            print('PASS: incident persisted while voice session remains open')
            await say('Correction, there are four people, and the address is 456 Hotel Circle North in Mission Valley. We are still upstairs.')
            async with asyncio.timeout(90):
                while True:
                    transcript=await query('calls:transcriptForCall',secret=secret,callId=call_id)
                    if transcript and 'four' in transcript.lower() and 'north' in transcript.lower(): break
                    if receiver.done(): receiver.result()
                    await asyncio.sleep(.5)
            current=await query('calls:statusForCall',secret=secret,callId=call_id)
            assert current['incidentId']==first['incidentId']
            state=await query('exercise:get')
            incident=next(i for i in state['incidents'] if i['_id']==first['incidentId'])
            assert incident['peopleCount']==4 and 'North' in incident['reportedAddress']
            assert 'Three' in incident['transcript'] or 'three' in incident['transcript']
            team=next(t for t in state['teams'] if t['available'])
            await mutation('incidents:verifyLocation',incidentId=incident['_id'],latitude=32.76,longitude=-117.17)
            await mutation('incidents:assignTeam',incidentId=incident['_id'],teamId=team['_id'])
            print('PASS: correction updated same incident; earlier transcript retained; local dispatcher approval saved')
            async with asyncio.timeout(60):
                while True:
                    audio=await played.get()
                    if team['name'] in audio['text']: break
            print('PASS: matching approved assignment audio received; playback completion SIMULATED')
            await asyncio.sleep(1)
            sender.cancel();await asyncio.gather(sender,return_exceptions=True)
            await ws.send(json.dumps({'type':'end'}))
            await asyncio.wait_for(receiver,75)
            ended=await query('calls:statusForCall',secret=secret,callId=call_id)
            assert not ended['callConnected'] and ended['status']=='assigned'
            print('PASS: hangup preserved assigned incident')
        finally:
            for task in [sender,receiver,*playback_tasks]: task.cancel()
            await asyncio.gather(sender,receiver,*playback_tasks,return_exceptions=True)
            await speech.close()
    print('NOT VERIFIED: microphone capture, browser audio output, human dispatcher or phone call')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api',default='http://127.0.0.1:8010')
    parser.add_argument('--convex-url',default='http://127.0.0.1:3210')
    parser.add_argument('--backend-secret-file',required=True)
    try:
        asyncio.run(main(parser.parse_args()))
    except Exception as exc:
        print('Exercise failed:',type(exc).__name__,'(provider response and credentials withheld)')
        raise SystemExit(1)
