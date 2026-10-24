# Voice backend (FastAPI)

Receives call utterances, has Claude pull out incident facts, saves them to Convex
(which the dashboard reads live), and hands confirmed dispatcher updates back to the
voice layer to speak.

```
Cartesia (voice) ──POST utterance──► FastAPI ──Claude extraction──► Convex ──live──► Dashboard
                ◄──GET announcements──        ◄────── events (assignment approved, en route) ──┘
```

## Run

```bash
# 1. Convex: the team shares the cloud deployment elegant-lark-857.
#    Only needed after editing dashboard/convex/*.ts (requires CONVEX_DEPLOY_KEY in dashboard/.env.local):
cd dashboard && npx convex deploy

# 2. Backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env      # fill in BACKEND_SECRET (ask the team) and ANTHROPIC_API_KEY
.venv/bin/uvicorn app.main:app --reload --port 8000

# 3. Simulate a call (no microphone needed)
.venv/bin/python scripts/simulate_call.py --scenario upstairs --listen 120
```

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
- The caller only hears updates the dispatcher confirmed, once each.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`.
