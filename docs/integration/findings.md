# Integration review: contract findings

Reviewed 2026-10-24 against `origin/dev` @ `1222cad`. Sources:

| Component | Where | State |
| --- | --- | --- |
| Core backend + Convex + dashboard | `origin/dev` | merged |
| Cartesia phone tools | PR #2 `feat/twilio-connection` (`backend/report_tools.py`, `backend/main.py`) | draft PR |
| Cartesia browser voice bridge | `codex/live-voice-dashboard` worktree (uncommitted: `backend/app/auth.py`, `voice_provider.py`, `main.py`, `convex/calls.ts`) | uncommitted WIP |
| ModernBERT inference | `codex/ml-inference` worktree (uncommitted: `backend/app/classifier.py`) | uncommitted WIP |
| Integration tests | `codex/demo-validation` worktree (uncommitted: `tests/integration/*`, `scripts/demo/validate.py`) | uncommitted WIP |

Paths below are relative to the repo root on the named branch.

## How the flow works on dev

1. **Call identity.** Whatever string the voice layer puts in `/calls/{call_id}`. Nothing authenticates it, and Convex
   indexes it with `by_callId` + `.first()`.
2. **Transcript ownership.** FastAPI keeps lines in memory per process (`backend/app/main.py` `_transcripts`) and writes
   the whole transcript to Convex on every turn. Convex is the copy that persists.
3. **Incident updates.** `calls:upsertFromCall` uses one incident per `callId`. Nulls never erase facts. Hazards are
   replaced whole by any non-empty list.
4. **Dispatcher approval.** `incidents:verifyLocation`, `assignTeam`, `setStatus` are public Convex mutations with
   **no authentication**.
5. **Announcements.** Approval inserts an `events` row. `GET /announcements` returns every unannounced row for the call.
6. **Acknowledgement.** `POST .../ack` sets `announcedAt`, without checking whether the event is still true.

## Prioritized findings

### P0: the demo can't work end to end yet

**F1. Three incompatible voice ingestion paths, each with its own call identity and transcript owner.**
- dev: the client chooses `callId`, and FastAPI builds the transcript from posted utterances.
- PR #2: identity is `("cartesia:{CARTESIA_AGENT_ID}", X-Cartesia-Call-Id)` and the transcript is fetched from
  Cartesia (`backend/report_tools.py` `call_identity`, `verified_transcript`). The Cartesia LLM writes the facts itself
  (`content_json`), and they go to `MemoryReportStore`, **never to Convex**. A phone call through PR #2 never appears on
  the dashboard and never gets an announcement.
- live-voice WIP: identity is the client `callId` plus `turn_id`/`sequence` receipts in new Convex tables
  `voiceCalls`/`voiceTurns`.

  PR #2 also adds a **second FastAPI app** (`backend/main.py`, imported as `backend.main`) next to `backend/app/main.py`.
  Only one can run on :8000.
  *Repro:* check out PR #2, run `uvicorn backend.main:app`, call the Cartesia number, open the dashboard: no incident.
  *Needed decision:* one entry point (`backend/app/main.py`), one incident store (Convex), and one fact extractor.

**F2. The live-voice WIP doesn't import.** `backend/app/main.py` ends with `from .voice import router`, but
  `backend/app/voice.py` doesn't exist in the worktree. *Repro:* in that worktree,
  `cd backend && .venv/bin/python -c "import app.main"` raises `ModuleNotFoundError: app.voice`.

**F3. Stale announcements on dev.** A pending event is never invalidated.
- Assign → unassign leaves "a rescue team has been assigned to you" queued.
- Assign → en route → resolved queues all three.
- Hang-up leaves them queued.
- A correction after dispatch keeps the old assignment announcement.

  *Repro:* `tests/integration/test_demo_flow.py` `test_gap_revoked_assignment_*`, `test_gap_superseded_*`,
  `test_gap_disconnected_*`, `test_gap_post_dispatch_*` (demo-validation WIP, currently `expectedFailure`).
  The live-voice WIP fixes this with `decisionRevision` + `currentEvent()`. That fix needs to land.

### P1: safety and correctness contracts

**F4. Failed persistence is logged as "transcript saved".** In `backend/app/main.py` the extraction error string says
  "transcript saved for the dispatcher" and is logged **before** the Convex write. When the write then fails, the log
  says the opposite of what happened. A bridge that speaks `extraction_error` would make the same false claim.
  Non-`ConvexError` failures (network, the plain `Error` thrown by the WIP's turn checks) escape as a bare 500.
  *Contract:* the voice layer may say "your report is saved" only after a 2xx carrying `incident.incidentId`.

**F5. Retries duplicate transcript evidence (dev).** The line is appended to `_transcripts` before the Convex write.
  A failed write leaves it in memory, so the retry appends it again. A retried POST after a lost response appends a
  second copy. The WIP's turn receipts fix this, but only when `turn_id`/`sequence` are sent. The legacy path still
  appends.

**F6. Corrections overwrite facts with no history.** `upsertFromCall` overwrites `peopleCount`, `reportedPosition`,
  `summary`, `hazards` (with their `evidence`), and `reportedAddress`. Only the address change is logged to activity.
  The transcript keeps the words, but the dashboard loses the previous value and its evidence.

**F7. Dispatcher operations are unauthenticated.** `exercise:reset`, `incidents:assignTeam`, `setStatus`,
  `verifyLocation`, `reportFromMap`, `setWaterLevel`, and `logNote` accept any caller holding the public
  `NEXT_PUBLIC_CONVEX_URL`, which ships in the browser bundle. `exercise:get` returns every transcript. Anyone with the
  URL can wipe the shared deployment.

**F8. Unauthenticated FastAPI on dev.** Anyone who can reach :8000 can create incidents and ack announcements.
  The live-voice WIP adds `Authorization: Bearer <BACKEND_SECRET>`, which breaks two clients:
  - `scripts/simulate_call.py` and `check_call_rules.py --live`, which send no header.
  - demo-validation tests that expect 200 without a header.

  It also reuses the Convex master secret as an HTTP bearer, so every HTTP client must hold the secret that unlocks all
  of `calls.ts`. CORS has no `allow_headers`, so a browser preflight with `Authorization` fails.

**F9. Turn mode creates an incident from the agent greeting** (live-voice WIP). The guard
  `speaker == "agent" and not lines[:-1] and not turn` skips greeting suppression whenever `turn_id` is set. The first
  agent turn creates a "Location not given yet" incident, which breaks the dev rule and
  `test_caller_details_create_one_incident_and_agent_greeting_creates_none`.

**F10. Interrupted playback.** Dev's contract is right: ack only after playback. Nothing enforces it, though.
  `markAnnounced` acks any event for the call, including stale ones. The bridge code that would honour "don't ack on
  barge-in" is the missing `voice.py` (F2). Owner must confirm: on interruption, don't ack, and re-poll.
  Re-poll must return the event only if it's still current.

### P2: advisory classification

**F11. ModernBERT has no integration seam.** `backend/app/classifier.py` is standalone, with no caller, schema field,
  or dashboard display. Constraints the integration must keep:
  - Tags are stored in a separate field and can't change `hazards`, `peopleCount`, `summary`, `status`, or location.
  - Classification runs after the incident write and never blocks or fails an utterance.
  - `status: disabled|unavailable` is normal operation.
  - Tags are tied to the transcript they scored, so a late result for an old transcript can't overwrite a newer one.

  `requirements-classifier.txt` also names a personal absolute path (`/Users/.../predict_local.py`).
  Remove it before committing.

**F12. Hang-up doesn't stop polling on dev.** `callEnded` sets `callConnected=false`, but `pendingEvents` still returns
  events, so a bridge that keeps polling would still play them. The WIP filters on `callConnected`. The bridge must also
  stop its poll loop on `/end`.

## Owner asks

- **Cartesia (PR #2 + live-voice WIP):**
  - F1: pick the single ingestion path. If the phone agent stays tool-driven, map
    `X-Cartesia-Call-Id` → `callId = "cartesia-<id>"` and write through `calls:upsertFromCall`.
  - F2: commit `voice.py`.
  - F9: fix the greeting guard.
  - F8: separate the bridge token from `BACKEND_SECRET`, or document that the bridge is server-side only.
  - F10: confirm the no-ack-on-interrupt rule.
  - Add an announcement path for phone calls.
- **ModernBERT:** F11. Expose `classify_text_async(text) -> ClassificationResult` as is. Integration wires it in.
- **Integration tests:**
  - Add `startVoiceCall`/`turnReceipt` (and any new functions) to the harness allowlist.
  - Send the auth header once F8 settles.
  - Flip `expectedFailure` gaps as fixes land.
  - Keep the tests in-process; no shared deployment.

## Status on `codex/integration-validation`

| Finding | Status |
| --- | --- |
| F1 three ingestion paths / PR #2 not persisted | **Open: owner decision** (PR #2 comment). Demo blocker for phone calls. |
| F2 `app.voice` missing | Resolved by the voice owner (`b18b4f6`) and merged here. Live Cartesia bridge exercise passes (verification D). |
| F3 stale announcements | Fixed here. `decisionRevision` on incidents and events, and `isCurrentEvent` gates both delivery and ack. Field names match the voice WIP. |
| F4 false "saved" | Fixed here. `saved` flag; error text no longer claims a save; 502 or 503 with "Not stored". |
| F5 duplicate line on retry | Fixed. A failed save no longer leaves the line in memory, and with the bridge merged, turn receipts make a retry after a lost response idempotent. Plain HTTP posts without `turn_id` can still append twice. |
| F6 corrections lose evidence | Fixed here. `factHistory` keeps earlier values and dropped hazards with their evidence, and the dashboard shows them under "Changed by caller". |
| F7 dispatcher ops open | Fixed here. `DISPATCHER_TOKEN`, entered at sign-in and kept in sessionStorage, never bundled. Required by every `exercise:*` and `incidents:*` function, including `exercise:get`. |
| F8 open FastAPI / shared secret | Fixed here. `Authorization: Bearer VOICE_BRIDGE_TOKEN` on `/calls/*`, separate from `BACKEND_SECRET`, fails closed; CORS allows the header. |
| F9 greeting creates incident in turn mode | Low risk. The bridge never persists its greeting, so the first stored turn is always the caller's. The HTTP path keeps the guard. A turn-mode agent line sent before any caller line would still create an incident (#3). |
| F10 interrupted playback | Fixed. The server refuses stale acks, and the merged bridge acks only on the browser's natural `onended`, never on barge-in. Verified with scripted playback events only. |
| F11 ModernBERT seam | Fixed. PR #6 is merged here. The classifier runs only when `CLASSIFIER_MODEL_PATH` is set, in the background with a timeout. `calls:setAdvisoryTags` writes only `advisoryTags` and rejects older versions. Live model verified (E). `requirements-classifier.txt` still names a personal path (#4). |
| F12 hang-up | Fixed. Delivery stops for disconnected calls, a late utterance no longer sets `callConnected` back to true, and the merged bridge cancels poll and playback on end. |
