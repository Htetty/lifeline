# Voice backend (FastAPI)

Receives call utterances, has Claude pull out incident facts, saves them to Convex
(which the dashboard reads live), and hands confirmed dispatcher updates back to the
voice layer to speak.

```
Cartesia (voice) ──POST utterance──► FastAPI ──Claude extraction──► Convex ──live──► Dashboard
                ◄──GET announcements──        ◄────── events (assignment approved, en route) ──┘
```

## Run

For the phone product path, see [Twilio bidirectional Media Streams](../docs/integration/twilio-media-streams.md).
It adds `POST /twilio/voice` and `WSS /twilio/media` to this same FastAPI app,
reusing Claude, Convex and the shared session controller. Follow its signed
readiness checks and routing backup before changing the existing number.

For the browser microphone → live dashboard → spoken dispatcher assignment flow,
use [the voice bridge guide](../docs/integration/live-voice-dashboard.md). It starts
an isolated local Convex deployment and does not change the working phone agent.

```bash
# Backend against an ALREADY PREPARED ISOLATED Convex deployment:
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env      # only if .env does not already exist; fill BACKEND_SECRET and ANTHROPIC_API_KEY privately (VOICE_BRIDGE_TOKEN is optional)
.venv/bin/uvicorn app.main:app --reload --port 8000

# Text simulation over the voice-agent stream (no microphone or playback); writes to the configured Convex:
.venv/bin/python scripts/simulate_call.py --interactive --listen 120

# Regression checks (add --live for real Claude calls and the WebSocket). Isolated deployments only:
.venv/bin/python scripts/check_call_rules.py --live
```

**No login for the demo.** The voice routes and the dashboard are open by default. Both locks are optional:
set `VOICE_BRIDGE_TOKEN` (backend) to require `Authorization: Bearer <token>` on `/calls/*`, the
`/calls/{id}/stream` WebSocket (header, or `?token=`) and `POST /voice/sessions`; set `DISPATCHER_TOKEN` on the Convex
deployment (`npx convex env set DISPATCHER_TOKEN <value>`) to make the dashboard ask for a passcode.
`BACKEND_SECRET` stays between this server and Convex (nobody types it); the browser never receives a provider key
or backend secret.
Do not run `scripts/check_call_rules.py` against the shared deployment: it changes
and deletes test incidents. Prefer the isolated fixture tests in the bridge guide.

Then in the dashboard: select the new incident, place it on its building, confirm the
location, approve a team. The simulator prints the confirmed update the caller would hear.

For phone calls using Photon location sharing, the caller's Confirm supplies the incident's
map coordinates directly instead of geocoding a spoken address. It uses the same incident,
map pin, dispatcher confirmation and assignment flow; see
[Photon setup](../integrations/photon/README.md). The backend's `CONVEX_URL` and dashboard's
`NEXT_PUBLIC_CONVEX_URL` must refer to the same deployment, with a matching `BACKEND_SECRET`.

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
| `utterance_result`: `reply`, `extraction`, `location_match` | Say `reply` if not null: it responds to what the caller just said (answers a question, acknowledges, or asks the next detail). `next_question` is a deprecated alias with the same value |
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
| `POST /calls/{callId}/utterances` `{speaker: "caller"\|"agent", text}` | After each finished utterance. Returns extracted facts and `reply` to say (`next_question`: deprecated alias). |
| `GET /calls/{callId}/announcements` | At a natural pause: confirmed updates that are still true, with approved wording. Re-poll right before speaking; empty after the call ends. |
| `POST /calls/{callId}/announcements/{eventId}/ack` | Only after the whole update was played; not if playback was interrupted. `acknowledged: false` means it was superseded. |
| `GET /calls/{callId}/status` | Confirmed status, for truthful answers to "is someone coming?". |
| `POST /calls/{callId}/end` | Caller hung up. The incident stays open. Stop polling and playback. |

## Rules this enforces

- Unknown facts stay null; a later null never erases a known fact.
- If extraction fails, the transcript is still saved and the incident still appears.
- A corrected address after review sends the incident back to `needs_review`.
- Assignment requires a dispatcher-confirmed location; a team can't be double-booked.
- The caller only hears updates that were confirmed and saved, once each; a newer progress update
  replaces an unspoken older one, dispatcher messages are never dropped.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`.
- The caller only hears updates the dispatcher confirmed, once each.
- Backend-only Convex functions (`convex/calls.ts`) require `BACKEND_SECRET`; dashboard functions require `DISPATCHER_TOKEN`.
- An update is never spoken once the dispatcher reversed or superseded it, or after the caller hung up.
- A caller correction keeps the earlier value and its evidence in `factHistory`.
- Optional ModernBERT tags (`CLASSIFIER_MODEL_PATH`) are stored only in `advisoryTags`, after the save, and never
  change incident facts. Without the model the backend works the same.
- The bridge checks that a dispatcher update is current before starting audio,
  retains interrupted updates, and acknowledges naturally completed browser playback.
  See the bridge guide for disconnect/crash limits; this is not a global exactly-once
  audible-delivery guarantee.
