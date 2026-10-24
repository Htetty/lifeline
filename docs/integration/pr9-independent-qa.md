# PR #9 independent phone QA — hold merge

Reviewed October 24, 2026 on `codex/phone-independent-qa`. Application code was
not edited. No PR/branch was merged, cloud functions deployed, phone routing
changed, tunnel restarted, or pre-existing service stopped. Only new tests and
this report are added. All database writes used a disposable local Convex project.

## Exact revisions and recommendation

- PR: <https://github.com/Htetty/lifeline/pull/9>
- **Reviewed and tested PR head:** `523bffcf51af125c649489acb58c154c37adf538`.
  Confirmed through GitHub and `git ls-remote` before and after the checks.
- Its original base is merged PR #8, `6ecdc6a5c8dc79e6dc84b64360b588d85d7b1894`.
- `refs/heads/dev` has since advanced to
  `5cfc7e5e2c9a83766b24e5075b286fb7da58e5a5`.
- **Separately tested GitHub-generated merge preview:**
  `aab9d59543f448d3a2b47000491eb15b7694bbcd`, whose parents are
  `6d6ac3c5a21d5f3f27b2c317296dd1bb092b1f87` and the reviewed PR head.
  It was fetched and archived into a separate temporary directory, not merged
  into any branch. Its target parent is older than the observed latest dev;
  latest dev has the same missing-export problem described below.

**Recommendation: HOLD merging into current dev.** The pinned PR head passes the
phone checks on its original base, but a clean textual merge is not a working
integration. The merge-preview phone session exits from a reproducible polling
exception. Reconcile the interface with current dev, rerun the combined tests on
an exact new candidate, and record a short human rehearsal before calling the
integrated phone path fully verified. The existing working phone at the reviewed
head was left running.

## Blocker P1: current dev removed an export required by the phone poller

At the PR head, `backend/app/voice.py:249` imports:

```python
from .main import announcements, ANNOUNCEMENTS
```

Current dev moved processing to `app/calls.py` and announcement wording to
text-bearing Convex caller updates. `app.main` no longer exports `ANNOUNCEMENTS`.
GitHub's merge preview retains the old import in `Session.poll_once()`.

The import is outside the method's exception handler. It raises **ImportError**;
`Session.run()` waits for the first completed task, observes the failed poller,
logs `Voice session ended with ImportError`, and closes the session. This breaks
phone intake/announcement handling even though GitHub reports a clean merge.
The same controller is used by the browser bridge.

Independent reproductions in `backend/tests/test_phone_races_qa.py`:

- `test_phone_poller_uses_exports_available_in_integrated_app`: ImportError.
- `test_idle_phone_session_does_not_end_from_polling_failure`: session finishes
  before the mock caller disconnects; the captured log identifies ImportError.

The whole six-test file passes at the exact PR head. On the merge preview it has
**2 failures, 4 passes**. This is an application failure, not a dependency or
test-fixture mismatch. The lifecycle reproduction uses the real `Session.run()`
with mocked storage/speech; no network or provider credentials are needed.

Reproduce without a branch merge or deployment, from the QA worktree:

```bash
qa_snapshot=$(mktemp -d /tmp/lifeline-pr9-preview.XXXXXX)
git archive aab9d59543f448d3a2b47000491eb15b7694bbcd | tar -x -C "$qa_snapshot"
cp backend/tests/test_phone_races_qa.py "$qa_snapshot/backend/tests/"
cd "$qa_snapshot"
# Use an existing interpreter with backend/requirements-dev.txt installed:
PYTHONDONTWRITEBYTECODE=1 /ABSOLUTE/PATH/TO/backend/.venv/bin/python \
  -m pytest -q backend/tests/test_phone_races_qa.py
```

Owner action: reconcile the phone replay/polling interface with dev's canonical
announcement text and expanded event types; preserve current-approval validation
and acknowledged-event replay. Merely adding an old mapping to silence the import
would not establish correct handling of dev's newer caller updates. Recheck the
full phone lifecycle and the current target base after the fix.

## Automated evidence on the pinned PR head

All application files came from a `git archive` of the exact reviewed head.
Dependencies were reused read-only from the existing Python virtualenv and
dashboard node_modules. No dependencies or provider settings were changed.

| Check | Independent result / scope |
| --- | --- |
| Original backend pytest suite | 47 passed, 3 skipped, 17 subtests passed. |
| Backend suite with QA additions | **53 passed, 4 skipped, 17 subtests passed**. The extra skip is the local-only QA integration module when no disposable deployment is supplied. |
| Original disposable real-Convex unittest suite | 38 run, OK, 1 optional real-model skip. |
| Same suite with real-socket QA additions | **40 run: 39 passed, 1 optional real-model skip**. |
| Convex fixture tests, `npm run test:voice` | **8 passed** with convex-test. |
| Dashboard route type generation | Passed. |
| Dashboard `tsc --noEmit --incremental false` | Passed. |
| Dashboard production `next build --webpack` | Passed in the temporary source copy. |
| Dashboard `npm run lint` | Exit 0; 0 errors, 1,103 warnings, largely generated/minified map worker code. Not represented as warning-free. |
| Existing demo harness | 22 run, OK with **2 expected failures** for count/hazard withdrawal policy. These are not phone acceptance passes. |
| Client build credential markers | No test backend/dispatcher/voice/signing secret markers in 35 built client assets; server credential names are absent from dashboard source/browser voice assets. This is a scoped build/source check, not a global secret audit. |

The independent socket tests use actual loopback TCP HTTP/WebSocket connections
to uvicorn, bound to OS-selected unused ports, and real Convex functions. They
mock only speech, Claude extraction, geocoding/classification and provider playback
marks. They are not a human audio test. Convex used ports **3460/3461**, with
fresh temporary storage. Those processes were stopped only by their own runner;
existing services on 3210/3310/3320 and the working phone/tunnel were untouched.

Reproduction commands from a disposable full-source export with existing
dependencies linked (first confirm 3460/3461 are unused, or select another pair):

```bash
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m pytest -q backend/tests
LIFELINE_LOCAL_CONVEX_PORT=3460 PYTHONDONTWRITEBYTECODE=1 \
  scripts/integration/local_convex.sh backend/.venv/bin/python \
  -m unittest discover -s backend/tests -v
cd dashboard
npm run test:voice
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:9 NEXT_TELEMETRY_DISABLED=1 \
  node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:9 NEXT_TELEMETRY_DISABLED=1 \
  node node_modules/next/dist/bin/next build --webpack
```

Never run the local runner from the working phone checkout or use an already
running Convex instance. Temporary exports omit all developer `.env` files and
deployment keys. The runner creates test-only secrets and refuses cloud targets.

### Coverage against the requested checks

| Requirement | Independent evidence at the reviewed head |
| --- | --- |
| Signed Twilio requests and trusted identity | Real HTTP/WSS reject unsigned traffic, a forged signing origin despite Host/forwarded headers, invalid CallSid and expired lease. Owner tests also cover account/number mismatch, call-bound lease, format, single use, duplicate frames and stream isolation. |
| One incident, ordered/idempotent turns | Real socket workflow ignores duplicate media and keeps one incident. All **7** durable caller/completed-agent receipts in this independent workflow resolve with their exact fingerprints and contiguous sequences 1–7; next sequence is 8. Atomic retry/collision/order tests also pass. This does not independently recount the human call's reported 22 receipts. |
| Address/count corrections and evidence | Three/South → four/North updates the same incident, retaining both caller statements and factHistory. |
| Current approved announcement only | Real Convex and fixture suites reject revoked/reassigned/corrected-location events. New QA race withdraws approval after synthesis/offer but before ready: no audio_go. |
| Explicit replay after acknowledgement | Real socket test requests replay, gets the approved matching team instead of the mocked injury question, and leaves the original acknowledgement timestamp unchanged. |
| Interruption/retry without automatic repetition | Real socket test interrupts the initial unacknowledged assignment, then an already acknowledged requested replay. Each clears and receives a fresh retry ID; a three-second quiet observation after normal completion produces no automatic output. |
| Clear-returned marks cannot falsely ack | Both socket flow and a new blocked-clear-write race exercise returned marks. Old marks remain cleared; no completion notification/ack is produced. |
| No overlap / coherent transitions | Output-slot reservation, cancellation during replay synthesis, pending-update/question suppression and post-question pause tests pass. Full acoustic overlap is not measured by these fixtures. |
| Hangup retains incident | Real socket stop closes the connection and leaves one disconnected, assigned incident with corrected North address, four people, transcript/history; announcement polling returns empty. Cleanup tests cover provider/tasks. |
| Failure claims follow persistence | Storage rejection, unavailable storage, lost response and extraction failure tests pass. New repeat-request persistence failure emits fatal/not-confirmed-saved, no saved/audio messages, and no advanced sequence. |
| Server credentials and operational documentation | Signatures/leases are server-side; browser bundles contain no test-secret markers. Startup/one-worker constraints and exact number-handler backup/rollback are documented. No routing/rollback operation was executed by QA. |

Twilio documents that clearing buffered audio also returns pending marks, so a
returned mark alone cannot distinguish natural completion from a clear. The
adapter invalidates mark state before awaiting the clear write. This matches the
[official mark/clear protocol](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
and uses the official validator described in
[Twilio request authentication](https://www.twilio.com/docs/usage/security).

## Live-provider evidence — separate from simulated protocol tests

Independently rerun with configured credentials passed privately in the child
environment; neither a phone nor any Convex deployment was contacted:

- `backend/scripts/probe_voice_path.py --phone`: live Cartesia Ink-2 finalized
  an STT turn in an open native μ-law/8000 Hz stream; Sonic-3.6 produced **32,640
  raw μ-law bytes** for the second synthetic update. Passed. Input was generated
  speech and silence, not a microphone; no human speaker playback was performed.
- Live `extract_incident` with `claude-sonnet-5-5`, effort `low`: a fictional
  three/South → four/456 Hotel Circle North correction produced count 4,
  the corrected North address and `location_changed=true`. Passed. No storage.

These provider checks do not establish Twilio delivery, actual human hearing,
real microphone interruption timing, or the combined merge-preview workflow.

## Human evidence and timeline review

The owner/project owner reports a person heard **High-Water Truck 7**, requested
replay, interrupted that replay, and heard its complete matching retry. The phone
runbook records this separately from automated initial-assignment interruption.
The timeline is internally consistent:

| Owner-recorded UTC event | Meaning / limit |
| --- | --- |
| 19:52:30.828 → 19:52:38.918 | Initial assignment queued → natural mark. Original ack at 19:52:38.919. |
| 19:52:47.776 → 19:52:55.621 | Explicit requested replay completed after the original ack. |
| 19:54:28.299 → 19:54:29.698 → 19:54:29.988 | Later replay queued → clear → old mark ignored. |
| 19:54:36.189 → 19:54:44.134 | Fresh retry → natural completion. |

Owner reports the same incident retained the corrected North address, four
people, assignment/history after hangup, with 22 unique contiguous receipts and
one unchanged assignment ack. **These are attributed human/owner reports, not
an additional independent human call or a fresh read of the existing Convex
instance.** No recording/raw live-call database export was reviewed. The
independent isolated flow corroborates the corresponding protocol/state behavior.

The initial unacknowledged assignment was interrupted **automatically**, not
during that reported human call. Provider mark completion is not proof a person
heard or understood the full audio. The earlier failed human replay and question
cutoff remain correctly recorded as failures; the later retest does not erase them.

## Human follow-up after the merge blocker is fixed

Do not place another call against a broken candidate or change routing for this
QA report. The phone owner should prepare an owner-approved isolated candidate
after reconciliation, recording its exact commit and the resulting call ID.

Short script (fictional details only):

1. Hear the Lifeline simulation disclosure. Say: “Three upstairs at 123 Hotel
   Circle South.” Then: “Correction: four at 456 Hotel Circle North.” Verify one
   incident, count 4, preserved evidence and review of the corrected location.
2. Have the dispatcher confirm this call's location and approve one available
   simulated team. As the **first unacknowledged assignment starts**, say “Wait,
   hold on.” Confirm audible output stops. Check clear/ignored-mark evidence and
   that the event is still unacknowledged. Stay quiet for the complete retry.
3. State the team name you actually heard and confirm the whole matching retry
   was audible, with no overlapping question. Wait at least ten seconds: it must
   not automatically repeat. Then request one replay and interrupt it early;
   hear its complete retry and confirm the original ack timestamp is unchanged.
4. Hang up. Confirm no further audio and one disconnected/open assigned incident,
   four people, North address/history, and unique contiguous receipts 1–N.

Success requires an explicit human confirmation of the heard team, completeness,
interruption stopping and lack of overlap, plus matching state/mark evidence.
A logged mark or simulated playback_complete does not pass the human criteria.
This follow-up remains **not performed / not passed** by independent QA.

## Limits and documentation notes

- Leases, queued/uncommitted speech and playback state are process-local: one
  worker, no supported transparent reconnect, no globally exactly-once audible
  delivery across crashes or lost marks/acks. Incident and committed turn receipts
  are durable in Convex; call-ended persistence failure can require recovery.
- The pinned head retains two known omission-versus-withdrawal gaps in the legacy
  demo harness. They are not newly introduced by this phone PR and must not be
  called passing retraction acceptance tests.
- Current target dev allows missing voice/dispatcher passcodes for open-demo
  mode. Passing protected PR-head tests does not certify that mode. Keep nonempty
  server credentials and do not assume tenant isolation or production readiness.
- Rollback instructions correctly preserve handler precedence, application/trunk,
  URL/method/fallback and avoid deleting the number/managed agent. The existing
  private routing backup is mode 0600; its secret/routing values were not copied
  into this report. Rollback itself was not exercised.
- `docs/integration/verification.md` contains historical PR #8-era statements
  that phone/human tests were unavailable. Use the newer phone runbook for its
  attributed human record and this report for independent results and the blocker.
