"""Play a fictional call into the backend over the voice-agent WebSocket.

    python scripts/simulate_call.py                    # default scenario
    python scripts/simulate_call.py --scenario correction
    python scripts/simulate_call.py --interactive      # you type the caller's lines
    python scripts/simulate_call.py --listen 120       # keep the call open for dispatcher updates

This behaves like a minimal voice agent: it sends caller lines, "speaks" Claude's
next question, and speaks pushed announcements (printing them), acknowledging each
one after playback. Status changes from the dashboard are printed as they arrive.
"""

import argparse
import asyncio
import json
import uuid

import websockets

SCENARIOS = {
    "upstairs": [
        "Help, the water is coming into our building really fast.",
        "We're in the apartments on Camino de la Reina, the big beige building across from the shopping centre.",
        "There's three of us, me, my husband and my mum. We went up to the second floor.",
        "My mum is 82 and she can't do stairs well. The water is already halfway up the first floor stairs.",
    ],
    "hotel": [
        "Please help, we're stuck at the Handlery Hotel, the water is up to the lobby.",
        "Four of us, we're on the third floor, room 312.",
        "My son has asthma and we're running low on his inhaler.",
    ],
    "correction": [
        "I'm stuck in my car, no wait, I got out, I'm on the roof of a shop.",
        "It's on Hotel Circle South, near the Days Inn.",
        "Sorry, I'm wrong, it's Hotel Circle North, the side by the river.",
        "Just me. The water is around the doors and it's moving fast.",
    ],
    "unclear": [
        "Hello? I don't know exactly where I am, I'm not from here.",
        "There's a gas station and a big hotel sign, I'm on a low roof behind them.",
        "Two of us. My friend cut her leg on something in the water.",
    ],
}

PLAYBACK_SECONDS = 1.5  # pretend time to speak an announcement


async def run(args: argparse.Namespace) -> None:
    call_id = f"call-sim-{uuid.uuid4().hex[:8]}"
    url = f"{args.api.replace('http', 'ws', 1)}/calls/{call_id}/stream"
    print(f"Call {call_id} ({'interactive' if args.interactive else args.scenario})\n")

    async with websockets.connect(url) as ws:
        results: asyncio.Queue[dict] = asyncio.Queue()
        cancelled: set[str] = set()

        async def send(message: dict) -> None:
            await ws.send(json.dumps(message))

        async def speak(event_id: str, text: str) -> None:
            await asyncio.sleep(PLAYBACK_SECONDS)
            if event_id in cancelled:
                print(f"  (not spoken, replaced by a newer update: {text[:60]}…)")
                return
            print(f"Agent (update): {text}")
            await send({"type": "ack", "eventId": event_id})
            await send({"type": "utterance", "speaker": "agent", "text": text})

        async def receive() -> None:
            async for raw in ws:
                message = json.loads(raw)
                kind = message["type"]
                if kind == "status" and message["status"]:
                    s = message["status"]
                    print(f"  [status] {s['stage']} · team={s['assignedTeamName']} · if asked: {s['sayIfAsked']}")
                elif kind == "announcement":
                    asyncio.create_task(speak(message["eventId"], message["text"]))
                elif kind == "announcement_cancelled":
                    cancelled.add(message["eventId"])
                elif kind == "idle_update":
                    print(f"Agent (still waiting): {message['text']}")
                elif kind == "utterance_result" and message.get("extraction") is None and message.get("incident") is None:
                    pass  # result of an agent line we sent while speaking; nothing to show
                elif kind in ("utterance_result", "error"):
                    await results.put(message)

        receiver = asyncio.create_task(receive())

        async def caller_lines():
            if not args.interactive:
                for line in SCENARIOS[args.scenario]:
                    print(f"Caller: {line}")
                    yield line
                    await asyncio.sleep(args.pause)
                return
            print("Type what the caller says. Press Enter on an empty line to stop talking.\n")
            while line := (await asyncio.to_thread(input, "Caller: ")).strip():
                yield line

        async for line in caller_lines():
            await send({"type": "utterance", "speaker": "caller", "text": line})
            body = await results.get()
            while body["type"] == "utterance_result" and body.get("extraction") is None and not body.get("extraction_error"):
                body = await results.get()  # skip results for agent lines
            if body["type"] == "error":
                print(f"  ! {body['error']}")
                if body.get("sayToCaller"):
                    print(f"Agent: {body['sayToCaller']}")
                continue
            if body.get("extraction_error"):
                print(f"  ! {body['extraction_error']}")
            facts = body.get("extraction") or {}
            print(
                f"  → address={facts.get('reported_address')!r} people={facts.get('people_count')} "
                f"position={facts.get('reported_position')!r}"
            )
            if body.get("location_match"):
                print(f"  📍 placed on map: {body['location_match']} (unverified)")
            if question := body.get("next_question"):
                print(f"Agent: {question}")
                await send({"type": "utterance", "speaker": "agent", "text": question})

        if args.listen:
            print(f"\nCall stays open {args.listen:.0f}s: act on the dashboard and watch updates arrive...")
            await asyncio.sleep(args.listen)
        else:
            await asyncio.sleep(PLAYBACK_SECONDS + 1)  # let queued updates finish
        if args.hangup:
            await send({"type": "end"})
            await asyncio.sleep(0.5)
            print("\nCall ended (incident stays open).")
        receiver.cancel()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--scenario", choices=SCENARIOS, default="upstairs")
    parser.add_argument("--pause", type=float, default=2.0, help="seconds between scripted caller lines")
    parser.add_argument("--listen", type=float, default=0, help="seconds to keep the call open afterwards")
    parser.add_argument("--hangup", action="store_true", help="end the call at the end")
    parser.add_argument("--interactive", action="store_true", help="type caller lines; empty line to finish")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
