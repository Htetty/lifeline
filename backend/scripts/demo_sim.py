"""Demo simulation: a storm's worth of calls while the water rises, plus your own live calls.

    python scripts/demo_sim.py                       # ~1.5 min: 22 callers, water peaks after 60 s
    python scripts/demo_sim.py --region sf-waterfront   # the San Francisco waterfront instead
    python scripts/demo_sim.py --calls 46 --rise 150 --max-turns 5   # the long version, every caller
    python scripts/demo_sim.py --calls 3 --rise 30   # a short smoke test
    python scripts/demo_sim.py --no-reset            # keep the current exercise (no new teams)

What it does, against the backend on --api and the Convex deployment in backend/.env:
  1. Resets the exercise with simulated rescue teams at dry staging points
     (simulation:start), with teams finishing rescues by themselves.
  2. Replays the region's recorded storm (the 2017 San Diego River flood, or the 1983 SF
     storm tide with a metre of sea-level rise) from the first reading to the peak
     over --rise seconds, so the flood spreads on the map.
  3. As the water reaches each scripted caller's building (backend/scripts/sim/<region>.json,
     built by dashboard/scripts/sim/build-scenario.ts), places their call through the normal
     call stream. A second Claude plays the caller from a fictional persona and answers the
     dispatcher agent's questions, so every incident has a real transcript and extraction.
     The caller's location is pinned from the scenario, as a phone's location would be.

Your own calls (phone or browser) go through the same backend at the same time and are
handled exactly as before. Ctrl+C stops placing calls and hangs up the ones in progress.
All people, calls and teams are fictional.
"""

import argparse
import asyncio
import json
import math
import os
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import anthropic
import websockets
from convex import ConvexClient, ConvexError
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
# One scenario per region (dashboard/convex/regions.ts), built by dashboard/scripts/sim/build-scenario.ts.
SCENARIOS = Path(__file__).resolve().parent / "sim"
REGIONS = sorted(p.stem for p in SCENARIOS.glob("*.json"))

# $ per million tokens (input, output), for the cost estimate printed at the end.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}

# Simulated teams: (name, capabilities, how many).
TEAM_MIX = [
    ("Swift Water Boat", ["boat"], 7),
    ("High-Water Truck", ["high_water_vehicle", "road_vehicle"], 6),
    ("Fire Engine", ["road_vehicle"], 5),
    ("Helicopter Rescue", ["air"], 2),
]

AGENT_GREETING = "911, what's the address of your emergency?"

CALLER_SYSTEM = """\
You are role-playing a caller in a flood-rescue training simulation. A dispatcher is on
the line. Everything is fictional; play it straight, like a real frightened person on
the phone.

Who you are and your situation:
{persona}

How to speak:
- Reply with ONLY what you say out loud next: one to three short spoken sentences. No
  stage directions, no quotation marks, no narration.
- Sound like a real person in this state: {temperament}.
- Answer what the dispatcher just asked. Don't recite every fact at once; let details
  come out over the call, the way people actually talk.
- Keep the facts above consistent. You can be vague or unsure about things you wouldn't
  know, but never contradict the facts you've been given.
- Describe where you are the way a person would (a business name, a street, what's next
  to you). Mention the street or place name early, because they'll need it to find you.
- If the dispatcher says help is on the way and has nothing more to ask, say a short
  goodbye or thanks."""


def persona_text(c: dict) -> str:
    who = "you" if c["role"] == "trapped" else "the people you can see"
    water = (
        "not inside yet, but the street and parking lot are flooded and you cannot get out"
        if c["waterAtCall"] == "none yet"
        else f"about {c['waterAtCall']} deep where {who} are"
    )
    lines = [
        f"- Your name: {c['callerName']}.",
        f"- Where: {c['location']}",
        f"- How many people need rescue ({who}): {c['people']}.",
        f"- Exactly where {who} are: {c['position']}.",
        f"- Water: {water}.",
        f"- Details: {c['story']}.",
    ]
    if c["role"] == "witness":
        lines.append("- You are a witness: you are safe and not in the water yourself.")
    return "\n".join(lines)


def env() -> dict[str, str]:
    return {**{k: v for k, v in dotenv_values(ROOT / "backend" / ".env").items() if v}, **os.environ}


@dataclass
class Stats:
    started: int = 0
    finished: int = 0
    failed: int = 0
    caller_turns: int = 0
    tokens: dict[str, list[int]] = field(default_factory=dict)  # model -> [input, output]

    def add_usage(self, model: str, usage) -> None:
        t = self.tokens.setdefault(model, [0, 0])
        t[0] += (usage.input_tokens or 0) + (usage.cache_read_input_tokens or 0) + (usage.cache_creation_input_tokens or 0)
        t[1] += usage.output_tokens or 0


class Sim:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        e = env()
        self.secret = e["BACKEND_SECRET"]
        self.voice_token = e.get("VOICE_BRIDGE_TOKEN", "")
        self.convex = ConvexClient(e["CONVEX_URL"])
        self.claude = anthropic.AsyncAnthropic(api_key=e.get("ANTHROPIC_API_KEY"))
        self.scenario = json.loads((SCENARIOS / f"{args.region}.json").read_text())
        # [time, water surface in metres NAVD88] from the region's gauge record.
        self.readings = self.scenario["readings"]
        self.stats = Stats()
        self.run_id = uuid.uuid4().hex[:6]
        self.rng = random.Random(args.seed)
        self.slots = asyncio.Semaphore(args.concurrency)
        self.t0 = 0.0

    def log(self, message: str) -> None:
        print(f"[{time.monotonic() - self.t0:6.1f}s] {message}", flush=True)

    async def mutation(self, name: str, **args):
        return await asyncio.to_thread(self.convex.mutation, name, {"secret": self.secret, **args})

    # ---- Setup -------------------------------------------------------------------

    def teams(self) -> list[dict]:
        staging = self.scenario["staging"]
        teams, n = [], 0
        for name, capabilities, count in TEAM_MIX:
            for k in range(count):
                lon, lat = staging[n % len(staging)]
                # Teams sharing a staging point park a little apart so each is visible.
                angle, ring = n * 2.4, 0.00025 * (1 + n // len(staging))
                teams.append({
                    "name": f"{name} {k + 1}",
                    "capabilities": capabilities,
                    "longitude": round(lon + ring * math.cos(angle) / math.cos(math.radians(lat)), 6),
                    "latitude": round(lat + ring * math.sin(angle), 6),
                })
                n += 1
        return teams

    def index_at(self, elapsed: float) -> int:
        start, peak = self.args.start_index, self.scenario["peakIndex"]
        return start + round((peak - start) * min(1.0, elapsed / self.args.rise))

    def schedule(self) -> list[tuple[float, dict]]:
        """When each call comes in: once the water reaches the building, after a short delay."""
        start, peak = self.args.start_index, self.scenario["peakIndex"]
        callers = self.scenario["callers"]
        if self.args.calls < len(callers):  # an even spread across the storm
            step = len(callers) / self.args.calls
            callers = [callers[int(k * step)] for k in range(self.args.calls)]
        times = []
        for c in callers:
            reached = max(0.0, (c["onsetIndex"] - start) / max(1, peak - start)) * self.args.rise
            times.append((reached + self.rng.uniform(2, 10), c))
        times.sort(key=lambda x: x[0])
        # Spread out calls that would arrive together (e.g. everything already wet at the start).
        out, last = [], -math.inf
        for at, c in times:
            at = max(at, last + self.args.min_gap)
            out.append((at, c))
            last = at
        return out

    # ---- One call ------------------------------------------------------------------

    async def caller_line(self, caller: dict, dialogue: list[dict]) -> str:
        response = await self.claude.messages.create(
            model=self.args.caller_model,
            max_tokens=2000,
            system=CALLER_SYSTEM.format(persona=persona_text(caller), temperament=caller["temperament"]),
            output_config={"effort": "low"},
            messages=dialogue,
        )
        self.stats.add_usage(self.args.caller_model, response.usage)
        text = " ".join(b.text for b in response.content if b.type == "text").strip().strip('"')
        return text or "Please, we need help, the water's coming up."

    async def call(self, caller: dict) -> None:
        async with self.slots:
            self.stats.started += 1
            call_id = f"call-sim-{self.run_id}-{caller['id']}"
            label = caller["place"]
            self.log(f"☎  {caller['id']} calling from {label} ({caller['people']} people, {caller['position']})")
            try:
                await self._talk(call_id, caller)
                self.stats.finished += 1
            except Exception as e:  # one failed call must not stop the simulation
                self.stats.failed += 1
                self.log(f"✗  {caller['id']} failed: {type(e).__name__}: {e}")

    async def _talk(self, call_id: str, caller: dict) -> None:
        url = f"{self.args.api.replace('http', 'ws', 1)}/calls/{call_id}/stream"
        headers = {"Authorization": f"Bearer {self.voice_token}"} if self.voice_token else {}
        async with websockets.connect(url, additional_headers=headers) as ws:
            send_lock = asyncio.Lock()
            results: asyncio.Queue[dict] = asyncio.Queue()
            dialogue: list[dict] = [{"role": "user", "content": f"Dispatcher: {AGENT_GREETING}"}]

            async def send(message: dict) -> None:
                async with send_lock:
                    await ws.send(json.dumps(message))

            async def agent_says(text: str) -> None:
                await send({"type": "utterance", "speaker": "agent", "text": text, "source": "simulation"})

            async def receive() -> None:
                async for raw in ws:
                    message = json.loads(raw)
                    if message["type"] == "announcement":
                        # The agent reads confirmed updates to the caller; keep them in the transcript.
                        await agent_says(message["text"])
                        await send({"type": "ack", "eventId": message["eventId"]})
                        dialogue.append({"role": "user", "content": f"Dispatcher: {message['text']}"})
                    elif message["type"] == "utterance_result" and (message.get("extraction") or message.get("extraction_error")):
                        await results.put(message)
                    elif message["type"] == "error":
                        await results.put(message)

            receiver = asyncio.create_task(receive())
            ended = False
            try:
                await agent_says(AGENT_GREETING)
                pinned = False
                for turn in range(self.args.max_turns):
                    line = await self.caller_line(caller, dialogue)
                    dialogue.append({"role": "assistant", "content": line})
                    # Roughly how long it takes to say it.
                    await asyncio.sleep(min(4.0, 0.6 + len(line) / 25))
                    await send({"type": "utterance", "speaker": "caller", "text": line, "source": "simulation"})
                    self.stats.caller_turns += 1
                    body = await asyncio.wait_for(results.get(), timeout=90)
                    if body["type"] == "error":
                        raise RuntimeError(body["error"])
                    if not pinned:
                        await self.mutation(
                            "simulation:pinCall", callId=call_id,
                            latitude=caller["latitude"], longitude=caller["longitude"], label=caller["place"],
                        )
                        pinned = True
                    question = body.get("next_question")
                    if not question or turn == self.args.max_turns - 1:
                        break
                    await agent_says(question)
                    dialogue.append({"role": "user", "content": f"Dispatcher: {question}"})
                facts = (body.get("extraction") or {})
                self.log(f"✓  {caller['id']} done: {facts.get('people_count')} people, {facts.get('reported_position')!r}")
                # Stay on the line a little, hearing updates, then hang up (the incident stays open).
                await asyncio.sleep(self.rng.uniform(*self.args.linger))
                await send({"type": "end"})
                ended = True
                await asyncio.sleep(0.5)
            finally:
                receiver.cancel()
                if not ended:  # stopped or failed mid-call: hang up so the incident shows the call ended
                    try:
                        await asyncio.wait_for(send({"type": "end"}), 2)
                        await asyncio.sleep(0.3)
                    except Exception:
                        pass

    # ---- Run -------------------------------------------------------------------------

    async def water(self) -> None:
        last = -1
        while True:
            index = self.index_at(time.monotonic() - self.t0)
            if index != last:
                at, level = self.readings[index]
                await self.mutation("simulation:setWaterLevel", meters=level, observedAt=at)
                if index // 10 != last // 10 or index == self.scenario["peakIndex"]:
                    self.log(f"🌊 water at {level:.2f} m above sea level (reading {index})")
                last = index
            if index >= self.scenario["peakIndex"]:
                return
            await asyncio.sleep(self.args.water_every)

    async def run(self) -> None:
        start_at, start_level = self.readings[self.args.start_index]
        if not self.args.no_reset:
            teams = self.teams()
            await self.mutation(
                "simulation:start", teams=teams, onSceneSpeedup=self.args.on_scene_speedup,
                waterSurfaceElevation=start_level, waterObservedAt=start_at, region=self.args.region,
            )
            print(f"Exercise reset in {self.args.region} with {len(teams)} simulated teams.")
        plan = self.schedule()
        print(f"{len(plan)} calls over ~{plan[-1][0]:.0f}s; water rises to the storm's peak over {self.args.rise:.0f}s. Ctrl+C to stop.\n")
        self.t0 = time.monotonic()
        tasks = [asyncio.create_task(self.water())]
        for at, caller in plan:
            await asyncio.sleep(max(0.0, at - (time.monotonic() - self.t0)))
            tasks.append(asyncio.create_task(self.call(caller)))
        await asyncio.gather(*tasks)

    def summary(self) -> None:
        s = self.stats
        print(f"\n{s.started} calls placed, {s.finished} completed, {s.failed} failed; {s.caller_turns} caller turns.")
        total = 0.0
        for model, (tin, tout) in s.tokens.items():
            price = PRICES.get(model)
            cost = (tin * price[0] + tout * price[1]) / 1e6 if price else None
            total += cost or 0
            print(f"  caller Claude ({model}): {tin:,} input + {tout:,} output tokens" + (f" ≈ ${cost:.2f}" if cost is not None else ""))
        print(f"  backend extraction: {s.caller_turns} requests on the backend's SIM_CLAUDE_MODEL, Haiku by default (one per caller turn; not metered here).")
        if total:
            print(f"  caller side total ≈ ${total:.2f}. The Anthropic Console has the exact bill.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--api", default="http://localhost:8000")
    p.add_argument("--region", default="mission-valley", choices=REGIONS, help="where the exercise runs")
    p.add_argument("--calls", type=int, default=22, help="how many scripted callers, spread across the storm (the scenario has 46)")
    p.add_argument("--rise", type=float, default=60, help="seconds for the water to reach the storm's peak")
    p.add_argument("--start-index", type=int, default=0, help="gauge reading to start from")
    p.add_argument("--water-every", type=float, default=4, help="seconds between water level updates")
    p.add_argument("--min-gap", type=float, default=2, help="fewest seconds between two new calls")
    p.add_argument("--concurrency", type=int, default=12, help="simulated calls on the line at once")
    p.add_argument("--max-turns", type=int, default=3, help="most caller turns per call")
    p.add_argument("--linger", type=float, nargs=2, default=(3, 8), metavar=("MIN", "MAX"), help="seconds on the line after the questions")
    p.add_argument("--on-scene-speedup", type=float, default=30, help="how much faster than real time rescues finish")
    p.add_argument("--caller-model", default="claude-haiku-5-5", help="model that plays the callers")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--no-reset", action="store_true", help="don't reset the exercise or load simulated teams")
    sim = Sim(p.parse_args())
    try:
        asyncio.run(sim.run())
    except KeyboardInterrupt:
        print("\nStopped.")
    except ConvexError as e:
        print(f"Convex refused: {e.data}")
    finally:
        sim.summary()


if __name__ == "__main__":
    main()
