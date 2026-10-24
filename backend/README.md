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

# 3. Simulate a call over the voice-agent stream (no microphone needed)
.venv/bin/python scripts/simulate_call.py --interactive --listen 120

# 4. Regression checks (add --live for real Claude calls and the WebSocket)
.venv/bin/python scripts/check_call_rules.py --live
```

Then in the dashboard: select the new incident, place it on its building, confirm the
location, approve a team. The simulator prints the confirmed update the caller would hear.

## Voice agent stream (use this)

One WebSocket per call: `ws://localhost:8000/calls/{callId}/stream`. Pick any unique `callId`.
The backend pushes every change from Convex; there is nothing to poll.

**Send** (JSON):

| Message | When |
| --- | --- |
| `{"type": "utterance", "speaker": "caller", "text": "..."}` | After each finished caller utterance |
| `{"type": "utterance", "speaker": "agent", "text": "..."}` | After the agent says something (keeps the transcript complete) |
| `{"type": "ack", "eventId": "..."}` | After an announcement **finished playing**. Not on interruption |
| `{"type": "end"}` | Caller hung up (the incident stays open) |

**Receive** (JSON):

| Message | What to do |
| --- | --- |
| `utterance_result`: `next_question`, `extraction`, `location_match` | Ask `next_question` if not null |
| `status`: `stage`, `sayIfAsked`, `assignedTeamName`, facts | Keep it in the LLM context. Answer "is anyone coming?" only from `sayIfAsked` |
| `announcement`: `eventId`, `kind`, `text` | Speak `text` word for word at the next pause, then `ack` |
| `announcement_cancelled`: `eventId` | A newer update replaced it. Don't speak it (stop if queued) |
| `idle_update`: `text` | Optional reassurance after ~75 s with no news; speak at a pause or ignore |
| `error`: `error`, `sayToCaller?` | Saving failed: say `sayToCaller`, never claim it was recorded |

Announcement kinds: `details_received`, `location_confirmed`, `location_unclear`, `assignment_approved`,
`assignment_changed`, `team_en_route`, `rescue_resolved`, `dispatcher_message` (typed by the dispatcher on the
dashboard), `report_linked` (the dispatcher matched this call to another report about the same people). Witnesses
get witness wording ("the people you reported"); `status.callerRole` says which. Wording lives in `dashboard/convex/callerUpdates.ts`, so the dashboard shows exactly what was said.

A minimal working client is `scripts/simulate_call.py`.

## REST endpoints (scripts, simple clients)

| Endpoint | Use |
| --- | --- |
| `POST /calls/{callId}/utterances` `{speaker, text}` | Same as the `utterance` message |
| `GET /calls/{callId}/state` | Status card and pending announcements (what the stream pushes) |
| `POST /calls/{callId}/announcements/{eventId}/ack` | Same as the `ack` message |
| `POST /calls/{callId}/end` | Same as the `end` message |

## Rules this enforces

- Unknown facts stay null; a later null never erases a known fact.
- If extraction fails, the transcript is still saved and the incident still appears.
- A corrected address after review sends the incident back to `needs_review`.
- Assignment requires a dispatcher-confirmed location; a team can't be double-booked.
- The caller only hears updates that were confirmed and saved, once each; a newer progress update
  replaces an unspoken older one, dispatcher messages are never dropped.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`.
