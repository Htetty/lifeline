# Live voice → dispatcher dashboard bridge

Implemented on `codex/live-voice-dashboard` from `origin/dev` commit `1222cad`.
This milestone uses a **browser microphone**, not the existing phone number.
The Managed Agent, Twilio routing, voice prompt, model and welcome message remain
unchanged. PR #2 (`origin/feat/twilio-connection`, `0b878c4`) was inspected for
authentication/transcript/diagnostic ideas; its separate memory-report store was
not merged. Incident persistence uses the existing Convex workflow.

## Integration decision, checked 2026-10-24

Started with [Cartesia's documentation index](https://docs.cartesia.ai/llms.txt).
The current [Managed Agent WebSocket guide](https://docs.cartesia.ai/line/integrations/websocket-api)
and [message reference](https://docs.cartesia.ai/api-reference/agents/agent-websocket)
support audio input, conversation events, and client tool responses. They do not
document an unsolicited backend announcement command or a client playback-complete
event. `turn_ended` does not establish that the caller heard audio.

[Webhook tools](https://docs.cartesia.ai/agents/webhook-tools) are agent-invoked
requests. [Dynamic variables](https://docs.cartesia.ai/agents/dynamic-variables)
populate session/tool context; neither documents asynchronous announcement push.
The [migration guide](https://docs.cartesia.ai/agents/migrate-from-line-sdk) says
Managed Agent lifecycle webhooks are coming soon. Legacy Line lifecycle hooks
are therefore not assumed to work for this agent. This evidence supports using
the explicitly authorized browser fallback; it does not prove that Cartesia can
never offer such a phone mechanism.

The separate browser path uses official `cartesia` Python SDK speech APIs:

```
Browser mic → authenticated FastAPI WebSocket → Cartesia Ink-2
             provider turn.end → ordered worker → existing Claude extraction
             → atomic Convex incident/receipt → existing dashboard
Dispatcher location confirmation + team approval → Convex event
             → FastAPI poll + current-decision checks → Sonic WAV
             → browser Web Audio → natural playback completion → acknowledgement
```

See [STT turn semantics](https://docs.cartesia.ai/use-the-api/stt/turns) and
[Auto STT API](https://docs.cartesia.ai/api-reference/stt/turns/websocket).
Only `turn.end` becomes a caller utterance. Partial, eager, absent and null
transcripts are never reconstructed by Claude. The provider guarantees a start
before each end and cumulative turn text; duplicate end events without a new
start are ignored. The dedicated provider connection has reconnection disabled.

Provider calls use HTTPS/WSS, bearer authentication through the official SDK,
and `Cartesia-Version: 2026-08-14` (the STT query also specifies that version).
The agent's existing voice is read, not modified. Its standalone `tts_model` is
currently absent, so the separate browser flow uses the tested documented
`sonic-3.6` model. Existing Claude model/effort remain unchanged. There is only one
conversation controller: Claude's existing `next_question`. No Managed Agent is
running a parallel browser conversation.

## Environment and startup

Install from repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd dashboard
npm ci
cd ..
```

Populate `backend/.env` privately; never paste values into chat or commit it:

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Existing Claude extraction |
| `VOICE_BRIDGE_TOKEN` | New random browser access credential, separate from backend secret |
| `CARTESIA_API_KEY` | Server-side speech access; root ignored `.env` also supported |
| `CARTESIA_AGENT_ID` | Read existing voice; root ignored `.env` also supported |
| `CONVEX_URL` | Isolated deployment for normal direct server startup |
| `BACKEND_SECRET` | Must match that deployment's backend secret |
| `CLAUDE_MODEL` | Optional; existing default `claude-sonnet-5-5` |
| `EXTRACTION_EFFORT` | Optional; existing default `low` |
| `CARTESIA_VOICE_ID`, `CARTESIA_TTS_MODEL` | Optional explicit browser overrides; set both to avoid agent lookup |

Generate `VOICE_BRIDGE_TOKEN` with a local password manager or
`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` in your own terminal,
then put it in the ignored file. Provider credentials never go into the browser.

Recommended isolated exercise (ports 3210, 3211, 8010 and 3100 must be free):

```bash
backend/.venv/bin/python backend/scripts/run_local_voice.py
```

This creates a private temporary project, copies Convex functions, uses anonymous
local Convex, generates its matching backend secret, and launches one FastAPI
process plus the existing dashboard. It removes cloud Convex selectors from the
Convex subprocess and overrides backend/dashboard URLs only in child environments.
It does not edit `.env`, reset data, or deploy to the shared cloud. The CLI can
download the official local Convex binary on first use. Ctrl-C stops these child
processes and keeps the printed state directory with its local data. Keep that
directory private; it contains local credentials. A fresh launch creates fresh
local state; it does not claim to reuse the previous exercise.

Open http://127.0.0.1:8010/voice and http://localhost:3100. Enter only
`VOICE_BRIDGE_TOKEN` into the local voice page. Use headphones, allow microphone
access, click Start, and wait for the disclosure. Loopback supports browser mic
access; a remotely hosted page must use HTTPS/WSS. Keep a single backend worker:
session tickets and active audio state are process-local.

For an already prepared isolated deployment (functions from this branch deployed,
matching secret configured, dashboard pointed at the same deployment):

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010
# Separate terminal, from dashboard, after setting NEXT_PUBLIC_CONVEX_URL locally:
npm run dev -- --port 3100
```

No Cartesia Console or Twilio configuration changes are required. The configured
key must have speech access and, when deriving the voice, agent-read access.
If agent retrieval is unavailable, set an actual authorized voice ID and model
locally; do not invent an ID. The current account passed STT, TTS and agent-read
checks. An isolated hosted deployment remains necessary for a remote shared demo;
the supplied backend `.env` still pointed at the team's shared cloud during this
work, so validation deliberately overrode it with localhost.

## Identity, ordering and delivery

- FastAPI generates a UUID call identity. A 60-second, one-use WebSocket ticket
  binds it to a same-origin connection. Caller JSON cannot submit text or select
  a provider identity. Only server-received SDK STT events enter extraction.
- Each finalized provider turn gets a server sequence. One worker processes all
  caller and naturally played agent turns in queue order. Audio reception and
  announcement polling continue while Claude, geocoding or persistence wait.
- A Convex mutation atomically checks the active call and next sequence, updates
  its incident, stores the exact response receipt, and advances the sequence.
  A retry first checks that receipt. A lost successful mutation response therefore
  cannot create another incident, append the turn twice, or re-extract different
  facts. Identity/fingerprint collisions and sequence gaps are rejected.
- Original caller transcript stays in the incident alongside corrections. Null
  extraction fields retain known facts. Extraction failure saves raw verified
  words with no invented facts; storage errors retry the same turn and stop the
  session on exhaustion rather than skipping to later speech.
- Dispatcher events carry a decision revision. Withdrawal, status changes or a
  corrected destination invalidate old announcements. Queries filter by current
  incident/call state; the bridge checks again after synthesis and immediately
  before granting browser playback. It waits for queued corrections to persist.
- A browser audio offer is decoded first, then the backend authorizes playback.
  Only natural `AudioBufferSourceNode.onended` sends completion. Explicit stop,
  caller interruption, failed decoding, hidden-tab interruption, and disconnect
  do not acknowledge an incomplete announcement. Web Audio's ended event can
  also fire after `stop()`, so the client explicitly tracks interruption; see
  [Web Audio specification](https://www.w3.org/TR/webaudio/#AudioScheduledSourceNode).
- A completed announcement with a lost ack response remains in completed state;
  polling retries its idempotent ack without replaying the audio. A superseded
  event cannot be acknowledged as current. Interrupted current announcements stay
  pending and can play again at a quiet pause.
- Ending drains finalized STT output and queued saves within bounded time, cancels
  audio/polling/work tasks, closes provider connections and mic tracks, and sets
  `callConnected=false`. It never resolves the incident.

## Verification recorded 2026-10-24

```bash
cd backend
.venv/bin/pytest -q tests
cd ../dashboard
npm run test:voice
npx tsc --noEmit
npx eslint convex/calls.ts convex/incidents.ts convex/schema.ts tests/calls.test.ts vitest.config.mts
```

Passed: 16 backend tests and seven isolated Convex fixture tests. Coverage includes
duplicates, retry ordering, lost mutation responses, call isolation, authentication,
null/delayed transcript text, extraction/storage failure, corrections, stale
announcements, interruption, completed-ack retries and disconnect task cleanup.
TypeScript, targeted ESLint, browser script syntax, and `git diff --check` passed.
The same-origin microphone worklet asset returns HTTP 200; a concurrent workspace
fix replaced the CSP-blocked blob worklet and was read, preserved and included.
`npm ci --dry-run --ignore-scripts` accepted the lockfile. No shared reset or
destructive regression command was run.

Provider-only synthetic probe:

```bash
backend/.venv/bin/python backend/scripts/probe_voice_path.py
```

Passed: real Ink `turn.end` before input closure and Sonic response generation while
STT remained open. This proves the two provider directions without claiming hearing.

Full synthetic exercise, while the isolated launcher is running, using the secret
file under its printed private state directory:

```bash
backend/.venv/bin/python backend/scripts/exercise_voice_bridge.py \
  --backend-secret-file /path/to/printed-state-directory/backend-secret
```

This script refuses non-loopback FastAPI/Convex URLs and never resets data.
Passed with live Cartesia, live Claude, and actual local Convex: finalized caller
speech created an incident before disconnect; corrected address and four people
updated that same incident; old transcript remained; scripted location confirmation
and approval emitted matching team audio; ending retained the assigned incident.
Playback-complete messages were **simulated**, not generated by a physical speaker.

Physical browser exercise: caller details and a correction reached local Convex
during a connected browser session (`browser-da7ccda3-37ea-44e7-b1bb-71d262687e65`).
The current incident had four people at 456 Hotel Circle North, Mission Valley;
earlier three-person/South-location words remained. The user confirmed hearing
the disclosure and being able to speak, then intentionally ended the session
before approving a team. The corrected incident remained `needs_review` and
disconnected afterward. Full assignment hearing with a human dispatcher remains
pending a session kept open through approval.
Browser automation through Superset was unavailable because the local CLI has no
authenticated session. Existing phone behavior was not retested.

## Short human exercise

1. Start microphone, listen to the simulation disclosure, then say:
   “This is a fictional flood. Three people are upstairs at 123 Hotel Circle South
   in Mission Valley. Water is rising on the stairs.”
2. Wait for Saved and confirm the incident appears on the dashboard while connected.
   Answer a follow-up if asked.
3. Say: “Correction: four people at 456 Hotel Circle North, still upstairs.”
   Wait for Saved; confirm the same incident ID, corrected fields and earlier words.
4. On the dashboard, select that incident, place its fictional location if needed,
   confirm location, then approve an available simulated team.
5. Keep the voice page open and quiet. Hear the simulation update naming that team.
   To test interruption, interrupt a first update; verify it remains pending and
   then completes at a quiet pause. A completed update should not repeat.
6. End session, wait for server disconnect, and confirm the incident remains assigned
   with a disconnected caller. Do not resolve or reset the exercise to end the call.

## Limits and rollback

This is one-process prototype transport, not durable audio delivery. Convex
incidents and committed retry receipts persist; raw audio and not-yet-committed
queued turns do not survive a process crash. A sustained storage outage beyond
the bounded retry/drain window is reported and may leave unsaved turns; check the
dashboard's last saved transcript. A failed final call-ended write is logged with
call identity for an operator retry of the authenticated end endpoint. There is
no automatic reconnection/resumption or persistent background recovery worker.

Browser completion confirms natural rendering, not human hearing or speaker
hardware. Across an abrupt browser/server crash precisely between hearing and ack,
exactly-once audible delivery cannot be guaranteed. A dispatcher can invalidate
audio just after the final check; polling stops it on observing the change but
cannot retract words already heard. Output is synthesized as a WAV before playing;
this is not streaming low-latency TTS. Session duration is capped at 30 minutes.

The dispatcher app retains its existing authentication model; this increment
authenticates bridge/session and backend ingestion endpoints, not the whole
dashboard. Pre-existing events without decision revisions are not replayed into
new bridge calls. No dashboard redesign, ModernBERT, routing changes, or phone
integration was added.

Rollback: stop the isolated launcher. No phone rollback is needed because no
provider configuration changed. Feature code/schema are confined to this branch;
do not merge/deploy until reviewed. If later deploying to hosted Convex, coordinate
the additive schema/functions and FastAPI bearer-auth change together with callers.
