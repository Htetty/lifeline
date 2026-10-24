# PR #11 independent QA

Reviewed October 24, 2026 on `codex/pr11-independent-qa`.

**Automated verdict: pass.** The previous polling/import blocker and idle-session
regression are fixed on the actual combined candidate. No new automated code
blocker was found. **Merge recommendation: hold until the human rehearsal required
by PR #11 is confirmed on this exact candidate.** Human audio is explicitly still
unverified in `phone-rehearsal.md`; earlier PR #9 hearing does not certify this code.
The code reconciliation is otherwise suitable for approval on the tested evidence.

## Exact tested revisions

| Revision | Value |
| --- | --- |
| PR #11 head | `75c7bf5d1d0394e8fa0edf168aaa1d7ca1921680` |
| Actual GitHub merge candidate tested | `cafde5c327b6743cb68f4d63a76d19e553479f11` |
| Candidate parents | `5cfc7e5e2c9a83766b24e5075b286fb7da58e5a5` (current dev), then the PR head |
| Identical file-tree hash for PR head and merge candidate | `2000741c9f76aac36190f97b10492c31bb0e7dd0` |

Both refs were confirmed again at the end. Unlike the PR #9 review, this tests the
combined code with the current target, not just a branch on an older base.
GitHub's generated candidate was fetched read-only and archived into a fresh
temporary directory; no branch/PR was merged. Application code was not edited.

## Independently reproduced results

| Check on the combined snapshot | Result |
| --- | --- |
| Backend/phone pytest | **59 passed, 4 skipped, 17 subtests passed** |
| Disposable real-Convex suite, including signed phone and loopback HTTP/WSS | **51 run, OK, 1 optional model-weight skip** |
| Strict demo gate | **23 passed**, exit 0, **no expected failures** |
| Convex caller/replay and grouping fixtures | **19 passed**: 10 caller/replay, 9 grouping |
| Priority rules/examples | **17 passed** |
| Next route type generation | Passed |
| TypeScript `--noEmit --incremental false` | Passed |
| Production build | Passed with `next build --webpack` |
| ESLint `src convex tests` | Passed, no output/warnings |
| Additional independent partner smoke tests | **2 passed** using real local Convex; text stream uses actual loopback TCP |
| Live Claude semantic/schema smoke | **2 passed**, separate provider-only checks; no storage/audio |

The four plain-pytest skips are the three local-Convex-dependent modules (run in
the real-Convex suite) and optional real classifier weights. The standalone
priority compilation and build wrote only into the temporary snapshot. The
default Turbopack build was not independently rerun; the tested build mode was
webpack. Provider/model/classifier accuracy is not established by mocked tests.

### Previous blockers: verified fixed, assertions retained

The two original QA files `test_phone_races_qa.py` and
`test_phone_independent_qa.py` are **byte-identical to QA commit `836a26c`**.
They were not weakened to make this candidate pass.

- `test_phone_poller_uses_exports_available_in_integrated_app` passes: the
  controller no longer imports retired `app.main.ANNOUNCEMENTS`.
- `test_idle_phone_session_does_not_end_from_polling_failure` passes: the session
  remains open until the mock caller disconnects.
- Polling resolves imports inside its exception handler and uses saved canonical
  event text. A failed check is logged and retried; the reconciliation test then
  recovers and offers a valid update instead of killing the call.
- Reconciliation tests preserve witness wording, truthful `assignment_changed`,
  explicit replay by event ID, and acknowledgement semantics. Deferred questions
  are asked after pending updates, and dropped after a new caller turn.
- Real-socket phone tests retain one corrected North/four-person incident,
  evidence, ordered/idempotent receipts, initial-unacknowledged interruption,
  ignored clear-returned marks, matching retry, acknowledged replay, interrupted
  replay/retry and hangup retention. Completion marks are simulated in these tests.

### Grouping regressions: verified

All nine grouping fixture cases pass. Meaningful assertions include:

- Different addresses about 22 m apart remain separate despite equal floor/count;
  the dashboard still suggests `possibly_same` for dispatcher review.
- Same floor/count at one hotel is still ambiguous. Same room at the same hotel
  still auto-links. Witnesses link to the matching building, not a neighbour.
- A linked caller correcting room 312 to 410 loses the inherited team/link and
  becomes a separate rescue. The original rescue's assignment remains intact.
- Corrections can regroup the report with its newly matching room. A main
  report's changed room releases unsupported automatic children.
- Dispatcher-made links remain, with a warning after relevant changes. Unchanged
  turns do not create spurious warnings.

An additional independent real-Convex test exercises the dispatcher link, unlink
and mark-separate mutations. Identical address/room/pin reports explicitly marked
separate remain separate after placement, with reciprocal separation records.

### Retraction regressions: verified

The disposable real-Convex suite runs all 11 focused withdrawal tests. They check
explicit count withdrawal to unknown, retained omissions, withdrawing one hazard
without deleting the others, risk-factor removal, original evidence plus retraction
words in history, new numeric corrections, idempotent/repeated withdrawal, hints
containing recorded hazard names, and retaining an approved assignment after count
withdrawal. Re-extraction of old evidence does not resurrect a withdrawn hazard;
new evidence can report it again. The strict demo gate's former expected failures
are now ordinary passing assertions.

## Partner features retained

Compared with current dev `5cfc7e5`, these files are byte-identical:
`backend/app/stream.py`, `backend/app/geocode.py`,
`dashboard/convex/callerUpdates.ts`, `dashboard/src/lib/priority.ts`,
`dashboard/src/lib/grouping.ts`, `dashboard/src/lib/store.ts`, and
`dashboard/src/components/FloodMap.tsx`. `main.py` only adds the Twilio router;
the dashboard component change displays withdrawal history rather than replacing
controls. The extraction changes add withdrawal handling while retaining partner
panic/role/location/status instructions.

Independent new tests in `backend/tests/test_pr11_partner_qa.py` verify:

1. The actual `/calls/{id}/stream` receives finalized text, persists a witness
   report with risk evidence, pushes witness-aware status and details updates,
   delivers a typed dispatcher message verbatim, records text acknowledgement in
   caller-update history, and ends explicitly without resolving the incident.
   Priority overrides set/clear successfully without changing underlying risks.
2. Dispatcher grouping controls remain usable, including explicit separation
   overriding otherwise matching room/address/pins.

The provider-only Claude checks use the configured `claude-sonnet-5-5`, effort
`low`, without changing settings. One fictional witness report retains four
people, room 312, child/neck-deep-water risk meaning, status intent and a search
for the reported Handlery building. A second produces explicit unknown-count and
both recorded hazard withdrawals. These are two smoke examples, not a general
accuracy evaluation; no provider response was stored in shared Convex.

## Isolation and reproduction

An archive of the exact GitHub candidate was used, omitting developer `.env`
files. Existing dependencies were reused read-only; none were installed/changed.
Only a fresh local Convex at **3560/3561** was used. Loopback uvicorn servers used
OS-selected unused ports. Only the runner's own temporary processes were stopped.
The working Convex/API/tunnel/ngrok PIDs were unchanged at the final check.

Commands on the disposable snapshot with dependencies available:

```bash
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m pytest -q backend/tests
LIFELINE_LOCAL_CONVEX_PORT=3560 PYTHONDONTWRITEBYTECODE=1 \
  scripts/integration/local_convex.sh backend/.venv/bin/python \
  -m unittest discover -s backend/tests -v
LIFELINE_DASHBOARD_NODE_MODULES=/PATH/TO/existing/dashboard/node_modules \
  backend/.venv/bin/python scripts/demo/validate.py --strict
cd dashboard
npm run test:voice
npm run test:priority
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:9 NEXT_TELEMETRY_DISABLED=1 \
  node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:9 NEXT_TELEMETRY_DISABLED=1 \
  node node_modules/next/dist/bin/next build --webpack
node node_modules/eslint/bin/eslint.js src convex tests
```

The new partner test was copied into the disposable snapshot and run separately
through the same runner with `-p test_pr11_partner_qa.py`; both tests pass. Check
that the selected ports are unused before running. Never use the working phone
checkout/deployment or stop its services to make these ports available.

## Remaining signoff and known limits

- **Human audio on this exact reconciled candidate remains unverified.** PR #11
  explicitly names that rehearsal as a merge gate. Follow
  [phone-rehearsal.md](phone-rehearsal.md): first-assignment interruption and full
  matching retry, explicit replay/interrupted replay, no overlapping question,
  quiet no-auto-repeat, and retained corrected incident after hangup. A person
  must confirm what they heard; marks and synthetic playback are not human proof.
  This QA did not change routing or place that call.
- Deploy reviewed Convex schema/functions before the matching backend when the
  owner authorizes rollout; `withdrawn`, `recordedHazards` and `eventId` are new
  interfaces. No hosted deployment or routing change was performed in this review.
- Preserved baseline limits: optional-token open-demo mode is not tenant/security
  hardening; generic text-stream abrupt disconnect does not persist `end_call`
  (the new smoke test uses explicit `end`); phone leases/playback/queued turns are
  process-local, requiring one worker and no transparent reconnect. None is
  presented as fixed by this PR or as a global exactly-once audio guarantee.
