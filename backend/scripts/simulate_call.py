"""Play a fictional call into the backend, as the voice layer would.

    python scripts/simulate_call.py                 # default scenario
    python scripts/simulate_call.py --scenario correction
    python scripts/simulate_call.py --listen 120    # then wait for dispatcher updates
    python scripts/simulate_call.py --interactive   # you type the caller's lines

Each caller line goes to POST /calls/{id}/utterances. The script prints Claude's
suggested follow-up question, then (with --listen) polls for confirmed updates and
"speaks" them by printing and acknowledging.
"""

import argparse
import time
import uuid
import os
from pathlib import Path
from dotenv import load_dotenv

import httpx

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


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--scenario", choices=SCENARIOS, default="upstairs")
    parser.add_argument("--pause", type=float, default=2.0, help="seconds between caller lines")
    parser.add_argument("--listen", type=float, default=0, help="seconds to wait for dispatcher updates")
    parser.add_argument("--hangup", action="store_true", help="end the call at the end")
    parser.add_argument("--interactive", action="store_true", help="type caller lines; empty line to finish")
    args = parser.parse_args()

    call_id = f"call-sim-{uuid.uuid4().hex[:8]}"
    print(f"Call {call_id} ({'interactive' if args.interactive else args.scenario})\n")
    if args.interactive:
        print("Type what the caller says. Press Enter on an empty line to stop talking.\n")

    def caller_lines():
        if not args.interactive:
            yield from SCENARIOS[args.scenario]
            return
        while line := input("Caller: ").strip():
            yield line

    with httpx.Client(base_url=args.api, timeout=120, headers={"Authorization": f"Bearer {os.environ['BACKEND_SECRET']}"}) as http:
        for line in caller_lines():
            if not args.interactive:
                print(f"Caller: {line}")
            r = http.post(f"/calls/{call_id}/utterances", json={"speaker": "caller", "text": line})
            r.raise_for_status()
            body = r.json()
            if body.get("extraction_error"):
                print(f"  ! {body['extraction_error']}")
            facts = body.get("extraction") or {}
            print(
                f"  → address={facts.get('reported_address')!r} people={facts.get('people_count')} "
                f"position={facts.get('reported_position')!r} status={body['incident']['status']}"
            )
            if body.get("location_match"):
                print(f"  📍 placed on map: {body['location_match']} (unverified)")
            question = body.get("next_question")
            if question:
                print(f"Agent: {question}")
                http.post(f"/calls/{call_id}/utterances", json={"speaker": "agent", "text": question})
            if not args.interactive:
                time.sleep(args.pause)

        if args.listen:
            print(f"\nWaiting {args.listen:.0f}s for dispatcher updates (assign a team on the dashboard)...")
        deadline = time.time() + args.listen
        while time.time() < deadline:
            for a in http.get(f"/calls/{call_id}/announcements").json():
                print(f"Agent (confirmed update): {a['text']}")
                http.post(f"/calls/{call_id}/utterances", json={"speaker": "agent", "text": a["text"]})
                http.post(f"/calls/{call_id}/announcements/{a['eventId']}/ack")
            time.sleep(2)

        if args.hangup:
            http.post(f"/calls/{call_id}/end")
            print("\nCall ended (incident stays open).")


if __name__ == "__main__":
    main()
