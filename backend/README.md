# Voice backend (FastAPI)

Receives call utterances, has Claude pull out incident facts, saves them to Convex
(which the dashboard reads live), and hands confirmed dispatcher updates back to the
voice layer to speak.

```
Cartesia (voice) ──POST utterance──► FastAPI ──Claude extraction──► Convex ──live──► Dashboard
                ◄──GET announcements──        ◄────── events (assignment approved, en route) ──┘
```

## Run

For the browser microphone → live dashboard → spoken dispatcher assignment flow,
use [the voice bridge guide](../docs/integration/live-voice-dashboard.md). It starts
an isolated local Convex deployment and does not change the working phone agent.

```bash
# Backend against an ALREADY PREPARED ISOLATED Convex deployment:
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env      # only if .env does not already exist; fill it privately
.venv/bin/uvicorn app.main:app --reload --port 8000

# Text simulation, no microphone or real playback; writes to configured Convex:
.venv/bin/python scripts/simulate_call.py --scenario upstairs --listen 120
```

All `/calls/*` endpoints require `Authorization: Bearer <BACKEND_SECRET>`.
Keep that credential server-side. The separate browser session boundary uses
`VOICE_BRIDGE_TOKEN`; the browser never receives a provider key or backend secret.
Do not run `scripts/check_call_rules.py` against the shared deployment: it changes
and deletes test incidents. Prefer the isolated fixture tests in the bridge guide.

Then in the dashboard: select the new incident, place it on its building, confirm the
location, approve a team. The simulator prints the confirmed update the caller would hear.

## API for the voice layer

| Endpoint | Use |
| --- | --- |
| `POST /calls/{callId}/utterances` `{speaker: "caller"\|"agent", text}` | After each finished utterance. Returns extracted facts and `next_question` to ask. |
| `GET /calls/{callId}/announcements` | At a natural pause: confirmed updates to speak, with approved wording. |
| `POST /calls/{callId}/announcements/{eventId}/ack` | After the update was actually played (so it isn't repeated). |
| `GET /calls/{callId}/status` | Confirmed status, for truthful answers to "is someone coming?". |
| `POST /calls/{callId}/end` | Caller hung up. The incident stays open. |

## Rules this enforces

- Unknown facts stay null; a later null never erases a known fact.
- If extraction fails, the transcript is still saved and the incident still appears.
- A corrected address after review sends the incident back to `needs_review`.
- Assignment requires a dispatcher-confirmed location; a team can't be double-booked.
- The bridge checks that a dispatcher update is current before starting audio,
  retains interrupted updates, and acknowledges naturally completed browser playback.
  See the bridge guide for disconnect/crash limits; this is not a global exactly-once
  audible-delivery guarantee.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`.
