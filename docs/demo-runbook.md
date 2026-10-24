# Lifeline demo validation and rehearsal

Baseline: `dev` at `1222cad`, reviewed October 24, 2026. The current references are
`HANDOFF.md`, `backend/README.md`, and the code. `PROJECT_PLAN.md` contains older
assumptions. The target is a **fictional live caller → FastAPI/Claude → Convex /
dispatcher dashboard → confirmed location and approved assignment → spoken update**.

This PR adds isolated checks and instructions only. It does not implement the
voice bridge. The active `codex/live-voice-dashboard` worktree was inspected
read-only; its uncommitted work is not part of the baseline tested here. Relay
the findings below through the project owner to the voice-bridge owner. Do not
modify that branch or its worktree to run these checks.

## Safe automated checks

From the repository root, with Node 22 and existing backend/dashboard dependencies:

```bash
backend/.venv/bin/python scripts/demo/validate.py
backend/.venv/bin/python scripts/demo/validate.py --dashboard
backend/.venv/bin/python scripts/demo/validate.py --strict
backend/.venv/bin/python scripts/demo/validate.py --walkthrough
```

The test runner does not install dependencies or load deployment credentials.
If dependencies already live in another worktree, use its Python interpreter
and point `LIFELINE_DASHBOARD_NODE_MODULES` at that worktree's existing
`dashboard/node_modules`. This reads dependencies without editing that worktree.
For a fresh setup, the installation commands are in the startup section below.

`tests/integration/test_demo_flow.py` exercises real FastAPI routes, extraction
response handling, the Python Convex adapter, and the real TypeScript Convex
handlers. Claude responses and geocoding are mocked. A fresh Node process per
test implements in-memory document access; socket connections in the Python
test process and fetch in the Node harness are blocked. The handler allowlist
excludes reset and purge operations. No Convex deployment is contacted.

The harness invokes handlers directly: it does **not** validate Convex arguments
or schema, model transactional races/OCC, enforce deployed indexes, run reactive
subscriptions, or establish multi-worker behavior. Assignment checks prove the
handler rejects a sequential attempt to reuse an unavailable team; they do not
prove concurrent database isolation. Invalid FastAPI payloads are tested through
Pydantic. Model accuracy is not measured by supplying mocked extractions.

`--dashboard` copies tracked dashboard files into a temporary directory, omits
all `.env` files, reuses installed dependencies, and uses a loopback placeholder
Convex URL. It runs route type generation, `tsc --noEmit --incremental false`,
and `next build --webpack`. The worker normally copied by `postinstall` is
copied only into that temporary directory. Next may fetch Google fonts during
the build; this is not a fully offline build. Build/type generation does not
edit the production dashboard, deploy Convex functions, or open the dashboard.

### Recorded baseline results

- **22 tests: 13 passing checks and 9 expected failures exposing application gaps.**
- Dashboard route type generation, standalone TypeScript checking, and the
  webpack production build passed with Next 16.4.3 / Node 22.23.1.
- Python environment: FastAPI 0.162.0, httpx 0.28.1, Anthropic 2.3.0,
  Convex Python 0.8.1, Pydantic 2.14.1. Dependency versions in the repository
  remain unchanged; rerun checks when upgrading or integrating the bridge.
- The default runner exits zero when only documented expected failures remain;
  it prints them as **KNOWN APPLICATION GAPS**, not acceptance passes.
  `--strict` exits nonzero while any remain. An unexpected success also fails
  the suite so a fixed behavior must be reviewed before removing its marker.
- **The strict demo gate is blocked. No microphone/audio, live Claude,
  cloud persistence, or browser reactive updates were verified by these checks.**

## Application findings to relay to the bridge owner

Reproduce these entirely in memory with the commands above. Each test suffix
below identifies a method in `DemoIntegration`; prefix it with `test_gap_`.
To run just one, use:

```bash
backend/.venv/bin/python -m unittest discover -s tests/integration \
  -p test_demo_flow.py -k revoked_assignment -v
```

| Finding / test suffix | Reproduction and actual baseline behavior | Required behavior |
| --- | --- | --- |
| `duplicate_utterance_delivery_must_not_duplicate_evidence` | POST the same caller text twice with `turn_id=fictional-turn-1`, `sequence=1`. Dev ignores those extra fields, appends the line twice and increments the version; it keeps one incident. | Durable event identity, payload-conflict detection and idempotent retry; do not deduplicate merely by text. Confirm the bridge's final identity field names. |
| `revoked_assignment_must_not_be_announced` | Create, confirm, assign, return status to `awaiting_assignment`, then GET announcements. The old assignment still appears. | Suppress revoked decisions before playback. |
| `superseded_updates_must_not_be_announced` | Assign → en route → resolved before polling. GET returns all three pending decisions. | Return only the update justified by current approved state. |
| `post_dispatch_location_correction_invalidates_old_update` | Assign, then correct the address before polling. The old assignment remains pending despite the changed destination evidence. | Invalidate the old announcement and require explicit dispatcher reconciliation; do not silently move an assigned team's pin. |
| `disconnected_call_must_not_receive_pending_speech` | Assign, POST end, then GET announcements. The pending assignment is still returned. | Closed calls receive no further speech; incident stays open. |
| `withdrawn_known_count_must_become_unknown` | Save count 3, then extract null after an explicit retraction. Stored count remains 3. | Distinguish omission from an explicit withdrawal; allow an evidenced correction to unknown. |
| `withdrawn_hazard_must_not_remain_current` | Save water-on-stairs hazard, then explicitly retract it and return an empty hazard list. Storage retains the old hazard. | Remove retracted current hazards while retaining transcript evidence. |
| `failed_storage_must_not_log_transcript_saved` | Mock extraction refusal and storage rejection together. HTTP correctly returns 502, but a warning already says “transcript saved for the dispatcher.” | Emit a saved claim only after storage success; surface both failures truthfully. |
| `unauthenticated_http_write_must_be_rejected` | POST caller speech without authentication. It succeeds and writes an incident through the backend's secret. | Authenticate/authorize ingestion and bind access to the intended call/exercise. |

The read-only bridge snapshot showed work toward bearer authentication,
`turn_id`/`sequence` receipts, decision revisions, and filtering disconnected or
outdated announcements. That is promising implementation evidence, **not a
passing combined run**. Do not mark these failures fixed until the bridge is
reviewed, its dependencies/schema are available, and the tests are adapted and
rerun in isolation. Count/hazard retraction and premature saved logging also need
explicit handling. No issue/contact was invented; coordination goes through the
project owner.

### Public-deployment blockers

Keep this a local/private fictional exercise until all of these are resolved:

- On tested dev, every `/calls/*` endpoint lacks HTTP authentication. Knowing a
  call ID permits reads, writes, ending the call, and acknowledging updates.
  `BACKEND_SECRET` protects Convex backend functions, not these HTTP routes.
  A CORS allowlist does not authorize clients.
- Public dispatcher functions in `dashboard/convex/incidents.ts` and
  `exercise.ts` have no identity/role checks. An arbitrary Convex client can
  confirm a location, assign teams, change status, reset the exercise, or read
  transcripts. Gate sensitive functions by authenticated dispatcher role and
  exercise membership, including cross-exercise incident/team checks.
- Use short-lived, call-scoped browser/session authorization. Never put
  `BACKEND_SECRET`, provider API keys, or `CONVEX_DEPLOY_KEY` in browser code or
  a `NEXT_PUBLIC_*` variable. Confirm rate limits, input limits, session expiry,
  and origin/provider verification for the chosen bridge boundary.
- Current dev's assignment/en-route wording sounds operational and includes
  advice; it does not itself identify the update as simulated. The live opening
  and approved announcements must clearly identify a fictional exercise and
  must not suggest real emergency-service notification or rescue.

## Startup and configuration

Run **`dashboard/`**, not the unrelated root Next.js starter. Run
**`backend/app/main.py` as `app.main:app` from `backend/`**, not a legacy
`backend/main.py` entry point. Use the same reviewed commit for dashboard,
backend, and the isolated deployment's Convex functions.

| Environment variable | Where / purpose |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | `dashboard/.env.local`; URL of the isolated demo deployment. Public URL only. |
| `CONVEX_URL` | `backend/.env`; must match the dashboard's isolated target. |
| `BACKEND_SECRET` | `backend/.env` and that deployment's server environment; must match. Never print or commit it. |
| `ANTHROPIC_API_KEY` | `backend/.env`; required for real extraction, not mocked checks. |
| `CLAUDE_MODEL` | Optional backend model selection; current code defaults to `claude-sonnet-5-5`. Confirm access without changing provider settings. |
| `EXTRACTION_EFFORT` | Optional backend setting; defaults to `low`. |
| `CONVEX_DEPLOY_KEY` | Deployment-owner provisioning only; not needed by the running browser/backend or these tests. |
| `LIFELINE_DASHBOARD_NODE_MODULES` | Optional validation-only path to existing dashboard dependencies. |

The in-progress bridge additionally reads server-only `CARTESIA_API_KEY` and
`VOICE_BRIDGE_TOKEN`, plus either `CARTESIA_AGENT_ID` or both
`CARTESIA_VOICE_ID` and `CARTESIA_TTS_MODEL`. These are **not dev prerequisites**.
The owner must confirm the final voice startup command, browser entry point,
session authorization and environment names before a live rehearsal. Do not
reconfigure the existing managed agent or assume these unmerged interfaces are
stable. No Cartesia path is required by the automated tests or text fallback.

Before runtime startup, have the deployment owner provision a disposable/private
deployment with reviewed functions and fictional teams. Verify the configured
URLs privately. `backend/.env.example` currently points to shared production
`elegant-lark-857`: **do not copy that default into an automated test target**.
The other deployment mentioned in HANDOFF is not proof of isolation either.
Do not run `exercise:reset`, `calls:purgeCheckIncidents`, the dashboard Reset
button, or `backend/scripts/check_call_rules.py` against shared data. The latter
mutates, resolves, and purges records even without `--live`. This runbook does
not deploy functions, reset data, or instruct a shared-deployment test run.

Separate terminals, after the private environment files have been provisioned:

```bash
# Backend terminal, from repo root
cd backend
python3 -m venv .venv                     # only if no environment exists
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
# Dashboard terminal, from repo root
cd dashboard
npm ci                                  # uses lockfile; postinstall copies map worker
npm run dev -- --hostname 127.0.0.1 --port 3100
```

```bash
# Readiness, from another terminal
curl --fail http://127.0.0.1:8000/health
# Open http://127.0.0.1:3100 and verify the fictional exercise banner and queue.
```

Health checks only confirm HTTP readiness. They do not confirm Claude access,
storage credentials, location search, microphone permission, or working audio.
Allow external map/elevation tiles and Google fonts if needed. Geocoding is
best effort: a failed search must leave the incident reviewable, and the
dispatcher can place it manually. Dependency installation is operator setup;
the validation scripts never install packages or change provider settings.

## Two-minute fictional demo

Pre-stage one available simulated team in the isolated exercise; leave existing
shared records untouched. Rehearse after the strict blockers are resolved or
state clearly that the following is a controlled happy-path demonstration with
known gaps. Do not demonstrate revoked/reassigned events as safe on baseline dev.

| Time | Action / spoken script | Evidence to show |
| --- | --- | --- |
| 0:00–0:15 | Presenter: “This is Lifeline, a fictional flood-response exercise. No real rescue is requested or dispatched.” Show dashboard and the bridge owner's confirmed browser voice UI. | Visible simulation label; microphone permission granted. |
| 0:15–0:40 | Caller: “For this simulation, three of us are upstairs at the Handlery Hotel on Hotel Circle North. Water is on the stairs.” | Exactly one new incident, count 3, transcript/evidence; candidate location remains unverified. Location search may need manual placement. |
| 0:40–1:00 | Caller: “Correction: two people, and we are at the Days Inn on Hotel Circle South, not the Handlery.” | Same incident ID; count 2; old and corrected speech retained; corrected location requires review. |
| 1:00–1:20 | Dispatcher places/confirms the corrected building, selects an available simulated team, and approves assignment. | Confirmed location before assignment; team becomes unavailable. No spoken assignment before approval. |
| 1:20–1:45 | Pause and let the approved update play. Caller asks a short follow-up or interrupts only if that path has been rehearsed. | Actual audible approved text, never an invented ETA or automatic en-route claim; ack only after completed playback. |
| 1:45–2:00 | End the call. Presenter: “The call ended; the dispatcher still owns this open incident.” | `callConnected=false`; incident remains assigned/open. No further audio after disconnect. |

Do not manually trigger duplicate production deliveries or inject failures into
a shared runtime. The isolated suite covers those adversarial paths. If a stage
runs long or voice fails, switch to the text fallback and say what changed.

## Text fallback

With the isolated backend running, the existing simulator on the tested dev
baseline can replace the microphone (it still uses real Claude and storage):

```bash
cd backend
.venv/bin/python scripts/simulate_call.py --api http://127.0.0.1:8000 \
  --interactive --listen 120 --hangup
```

Type the two fictional caller lines above; enter an empty line to begin polling,
then confirm the location and assign a team in the dashboard. The simulator prints
the approved update and acknowledges it as **simulated text playback**. It does
not synthesize, play, or test audio. `--hangup` calls end after the listen window.
Its HTTP errors must not be presented as a successful save. This existing script
does not send an authorization header; the bridge owner must supply an updated
authorized simulator or invocation if the integrated `/calls` routes require
bearer authentication. Never remove authentication to make the demo work.

If providers/deployment access are unavailable, run:

```bash
backend/.venv/bin/python scripts/demo/validate.py --walkthrough
```

This prints a deterministic **MOCKED TEXT WALKTHROUGH**, exercising the real
routes/handlers against in-memory data. It demonstrates same-incident correction,
approval, simulated text acknowledgement and open incident after hangup. Say:
“This fallback uses mocked extraction and local state; it is not live voice or
the deployed dashboard.” It requires no API keys or deployment connectivity.

## Actual microphone/audio verification — separate, not yet completed

After the bridge is integrated in an isolated deployment, record commit SHA,
browser/device, date, provider/model identifiers, call/incident IDs, and these
observations without storing secrets or real emergency information:

1. The opening is audible and clearly identifies a fictional simulation. Only
   the caller's finalized utterances create facts; interim STT does not duplicate
   turns. Confirm unknown details are not turned into guesses or zeros.
2. Speak the correction and compare transcript, dashboard count/location and
   stable incident ID. Confirm a real, answerable follow-up is heard once.
3. Approve an assignment and hear its exact authorized wording at a pause. An
   unapproved, revoked, replaced, or superseded decision must not be spoken.
4. Interrupt playback with speech: output stops promptly, the event is not
   prematurely acknowledged, and any retry is revalidated against current
   dispatch state. Duplicate polls must not start overlapping playback. Record
   exactly what was audible; backend ack tests do not establish this behavior.
5. End during playback and while waiting for an update. There is no late audio;
   the incident remains open. Confirm microphone tracks and connections close.
6. In isolated/mocked runs only, cause extraction and storage failures. Errors
   must be visible to the operator and no audible/text response may claim an
   unsaved report was saved. Restore only the isolated test setup afterward.

Ask the owner to confirm: finalized-turn identity and retry ordering; the single
announcement consumer or lease policy; whether interrupted speech resumes or
restarts; the exact playback-complete callback that authorizes ack; revalidation
at playback time; call-close handling; and the authenticated text fallback.
An idempotent ack is not proof of exactly-once audible playback across crashes
or a lost ack response. Synthetic TTS→STT probes also do not verify a physical
microphone, speakers, barge-in, or a dispatcher-to-caller live demonstration.
