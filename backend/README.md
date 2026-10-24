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
cp .env.example .env      # fill in BACKEND_SECRET, VOICE_BRIDGE_TOKEN (ask the team) and ANTHROPIC_API_KEY
.venv/bin/uvicorn app.main:app --reload --port 8000

# 3. Simulate a call (no microphone needed)
.venv/bin/python scripts/simulate_call.py --scenario upstairs --listen 120
```

Then in the dashboard: select the new incident, place it on its building, confirm the
location, approve a team. The simulator prints the confirmed update the caller would hear.

## API for the voice layer

Every `/calls/*` request needs `Authorization: Bearer <VOICE_BRIDGE_TOKEN>` (not the Convex secret).

| Endpoint | Use |
| --- | --- |
| `POST /calls/{callId}/utterances` `{speaker: "caller"\|"agent", text}` | After each finished utterance. Returns extracted facts and `next_question` to ask. |
| `GET /calls/{callId}/announcements` | At a natural pause: confirmed updates that are still true, with approved wording. Re-poll right before speaking; empty after the call ends. |
| `POST /calls/{callId}/announcements/{eventId}/ack` | Only after the whole update was played; not if playback was interrupted. `acknowledged: false` means it was superseded. |
| `GET /calls/{callId}/status` | Confirmed status, for truthful answers to "is someone coming?". |
| `POST /calls/{callId}/end` | Caller hung up. The incident stays open. Stop polling and playback. |

## Rules this enforces

- Unknown facts stay null; a later null never erases a known fact.
- If extraction fails, the transcript is still saved and the incident still appears.
- A corrected address after review sends the incident back to `needs_review`.
- Assignment requires a dispatcher-confirmed location; a team can't be double-booked.
- The caller only hears updates the dispatcher confirmed, once each.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`; dashboard functions require `DISPATCHER_TOKEN`.
- An update is never spoken once the dispatcher reversed or superseded it, or after the caller hung up.
- A caller correction keeps the earlier value and its evidence in `factHistory`.
- Optional ModernBERT tags (`CLASSIFIER_MODEL_PATH`) are stored only in `advisoryTags`, after the save, and never
  change incident facts. Without the model the backend works the same.
