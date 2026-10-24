"""Replay a recorded phone-call audio file through Cartesia STT, paced like a live call.

Diagnostics only: compares turn settings on the SAME audio. Input is raw 8 kHz mu-law
(what Twilio sends). Writes every STT event with its audio-clock time (ms since the
first frame was sent). Never prints credentials.

    backend/.venv/bin/python backend/scripts/replay_stt.py AUDIO.ulaw OUT.jsonl \
        [--end-threshold 0.2] [--eager-threshold 0.4] [--end-timeout-ms 5600]
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.voice_provider import VERSION, CartesiaSpeech  # noqa: E402

FRAME = 160  # 20 ms of 8 kHz mu-law, as Twilio sends


async def replay(audio: bytes, out: Path, turn: dict) -> None:
    speech = CartesiaSpeech(input_encoding="pcm_mulaw")
    try:
        async with speech.client.stt.auto_finalize.websocket(
            model="ink-2", encoding="pcm_mulaw", sample_rate=8000, extra_query={"cartesia_version": VERSION},
            max_retries=0, **turn,
        ) as stt:
            t0 = time.monotonic()
            events = []

            async def send():
                for i in range(0, len(audio), FRAME):
                    # Real-time pacing against an absolute schedule (no drift).
                    await asyncio.sleep(max(0.0, t0 + i / 8000 - time.monotonic()))
                    await stt.send_raw(audio[i:i + FRAME])
                await stt.send({"type": "close"})  # flush, as the app does at hangup

            async def receive():
                async for event in stt:
                    e = event if isinstance(event, dict) else event.model_dump()
                    events.append({"t_ms": round((time.monotonic() - t0) * 1000, 1),
                                   **{k: v for k, v in e.items() if k in ("type", "transcript")}})

            sender = asyncio.create_task(send())
            await asyncio.wait_for(asyncio.gather(sender, receive()), len(audio) / 8000 + 30)
    finally:
        await speech.close()
    out.write_text("".join(json.dumps(e) + "\n" for e in events))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--end-threshold", type=float)
    ap.add_argument("--eager-threshold", type=float)
    ap.add_argument("--end-timeout-ms", type=float)
    a = ap.parse_args()
    turn = {k: v for k, v in {"turn_end_threshold": a.end_threshold, "turn_eager_end_threshold": a.eager_threshold,
                              "turn_end_timeout_ms": a.end_timeout_ms}.items() if v is not None}
    asyncio.run(replay(a.audio.read_bytes(), a.out, turn))


if __name__ == "__main__":
    main()
