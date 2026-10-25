"""Read-only speech path probe: synthetic TTS -> live STT finalization -> TTS.

Does not connect to Convex, alter an agent, or claim microphone/playback testing.
Run from backend: .venv/bin/python scripts/probe_voice_path.py
"""
import asyncio
from pathlib import Path
import struct
import sys
import argparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.voice_provider import CartesiaSpeech


async def main(phone=False):
    speech = CartesiaSpeech(**({"input_encoding":"pcm_mulaw", "output_format":{"container":"raw","encoding":"pcm_mulaw","sample_rate":8000}} if phone else {}))
    try:
        pcm = await speech.synthesize("This is a fictional Lifeline exercise. Three people are upstairs in Mission Valley.", raw=True)
        if phone:
            audio, rate, chunk = pcm + bytes([255])*8000*8, 8000, 400
        else:
            samples = struct.unpack(f"<{len(pcm)//2}h", pcm)
            audio, rate, chunk = struct.pack(f"<{len(samples)}f", *(s / 32768 for s in samples)) + bytes(16000 * 4 * 8), 16000, 3200
        async with speech.listen(rate) as stt:
            async def send():
                for offset in range(0, len(audio), chunk):
                    await stt.send_raw(audio[offset:offset+chunk])
                    await asyncio.sleep(.05)
            sender = asyncio.create_task(send())
            try:
                async with asyncio.timeout(35):
                    async for event in stt:
                        if event.type == "error":
                            raise RuntimeError("STT provider rejected the probe")
                        if event.type == "turn.end" and event.transcript.strip():
                            print("PASS: provider-originated turn.end received before closing STT; characters=", len(event.transcript))
                            break
                    else:
                        raise RuntimeError("No finalized speech returned")
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
            # While the input connection remains open, synthesize backend-approved text.
            output = await speech.synthesize("Simulated dispatcher update: the approved demo team has been assigned.")
            assert len(output) > 44 and ((output[:4] != b"RIFF") if phone else (output[:4] == b"RIFF"))
            print("PASS: backend text synthesized while STT session open;", "native mulaw/8000 bytes=" if phone else "WAV bytes=", len(output))
            print("Existing voice reused; separate browser TTS model:", speech.model)
            print("NOT VERIFIED: physical microphone, speaker playback, dispatcher approval or Convex.")
    finally:
        await speech.close()


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phone',action='store_true',help='Probe native mulaw at 8 kHz, no phone call')
    try:
        asyncio.run(main(parser.parse_args().phone))
    except Exception as error:
        print("Probe failed:", type(error).__name__, "(provider body/credentials not printed)")
        raise SystemExit(1)
