# PR #13 independent QA — hold merge

Reviewed October 24, 2026. All newly created reports and scenarios were explicitly fictional.
No application implementation, dependency, routing or shared data changes were made.

## Exact candidate and isolation

| Reference | Commit |
| --- | --- |
| Pinned PR head, reviewed in `codex/pr13-independent-qa` | `e957bc4705ca8686ff05146990add0318607c389` |
| Current `origin/dev` / requested base | `47c2c3f08e71c22148e44f8a259633163d2905e2` |
| GitHub combined merge candidate, exported and tested | `42c0ce7d56f1f268d9e8af97e9a4cfd3367f62d5` |
| Identical head/candidate tree | `fc81018382458f78e0ccd9adc2f8144827fb0381` |

The combined candidate's parents are the dev and pinned head above. Both trees are identical,
so the findings apply to the pinned source and its integration with current dev. Remote refs
were checked again before completion; no newer head or dev changes were present.

Review worktree: `/Users/htetty/Developer/lifeline-pr13-qa`. Real Convex tests used an archive
of the combined candidate in a separate temporary directory, disposable anonymous Convex
storage and unused ports **3660/3661**, with test-only dispatcher/backend secrets. Existing
installed dependencies were reused. The archive contained no project `.env` files or shared
deployment keys. Only QA tests were copied into it after export; application source stayed
at the candidate tree. No shared reset, merge, deployment or Twilio operation was performed.
The test runner stopped its own local backend. Demo listeners remained the same processes:
3140 PID 58773, 8030 PID 62044, 3490/3491 PID 74381.

## Findings

### F1 — P1: a changed flood/priority model can leave an old plan approvable

`dashboard/convex/planning.ts:103` drops every resolved report from the fingerprint, but
`dashboard/src/components/Dashboard.tsx:230` includes **all** reports' water observations.
A resolved caller's updated water report therefore changes the flood without changing the
fingerprint. The real `approvePlan` mutation accepts the old route evidence and assigns.

Reproduction: create confirmed waiting A and confirmed caller report B; resolve B; record
a plan for A; update B with chest-deep water through `calls.upsertFromCall`; approve A's
old plan. The fingerprint remains identical and approval returns `ok: true`. The independent
fixture also runs `observationAt`/`computeFlood` and proves the resulting depth grid changes.
The real local Convex test reproduces the unchanged fingerprint and successful old approval.

There is also a browser-local gap: water priority uses asynchronously resolved building
height (`Dashboard.tsx:261`), while panel staleness only uses `stateFingerprint(state)`
(`AssignmentPlanner.tsx:73`). Changing the supplied priority from standard to critical,
without a database-state change, leaves the old plan enabled. This is reproduced against
the actual component in the hook harness. Pending river edits have the same UI issue:
`canApprove` at line 136 ignores `notReady`, although suggestions are disabled during that
edit. The local model already uses the draft level (`Dashboard.tsx:203`).

Suggested repair: include every observation actually consumed by the flood model, and bind
the panel to its derived priority/routing context (including loading/building resolution).
Disable approval during pending model edits. Server-known and browser-local invalidation
need separate explicit treatment; a database fingerprint alone cannot cover both.

### F2 — P2: a corrected count leaves the old capacity review valid

`dashboard/convex/planning.ts:42` omits `peopleCount`, even though the frozen proposal's
material warning incorporates it (`dashboard/src/lib/planner.ts:101`). Record a plan with
two people, update the same caller to forty, then approve. Both fixture and real local
Convex return success; the component keeps approval enabled and its old warning.

Capacity is intentionally not modeled; that makes the dispatcher reviewing the current
count especially relevant. Include count/unknown transitions in review invalidation rather
than implying that capacity validation is implemented.

### F3 — P2: an approval ID reused with a different request returns false success

`dashboard/convex/planner.ts:109` returns the prior receipt before checking `planId`, selected
pairs or evidence. Approve A/team-1 with ID X. Submit B/team-2 under a different plan with X.
The response is `{ok:true, outcome:"approved", assigned:1}`, but B is unassigned and no
decision for B was recorded. Reproduced against real Convex as well as fixtures.

This does not double-assign a team; it falsely reports that the new request succeeded.
`AssignmentPlanner.tsx:122` turns that response into a success message and closes the panel.
Bind idempotency receipts to a canonical request hash; reject conflicting reuse. Preserve
same-request retries. Reset the UI request identity when the selection changes.

### F4 — P2: valid aircraft routes fail the new server speed check

`dashboard/convex/planning.ts:138` measures longitude distance using the start latitude;
`dashboard/src/lib/router.ts:101` uses the road graph's midpoint latitude. The exact
maximum-speed check at `planning.ts:166` has no tolerance for that difference.

Reproduction with the checked-in graph bounds (south 32.752, north 32.776): an available
helicopter at (-117.1625, 32.756), target (-117.168, 32.762). Actual `planRoute` returns
16.86643240197915 seconds, but the validator demands at least 16.86699724866448 and rejects
it as faster than the team can move. Regeneration returns the same rejection.

The real local test first completes a normal manually assigned southern helicopter trip,
waits for the actual scheduled arrival, resolves that incident, and then submits actual
router evidence for the next incident. Approval rejects it. Use consistent distance math
and a justified numerical tolerance; retain rejection of genuinely impossible times.

### F5 — P2: malformed evidence bypasses advertised consistency checks

`dashboard/convex/planner.ts:26` permits arbitrary numeric arrays and unrestricted numbers.
`dashboard/convex/planning.ts:158` compares distances without first validating coordinates.
Empty/short arrays and NaN produce NaN distances; `NaN > 2` and the final speed comparison
are false, so they pass. Non-integer/NaN/infinite point counts also pass; negative or
negative-infinite depth passes the upper-bound check.

Reproduction: take an otherwise valid proposed boat pair and set `start:[], end:[]`; actual
Convex approval assigns. Independently set `points:NaN, maxDepth:-Infinity`; Convex's numeric
transport accepts them and approval also assigns. Nine malformed fixture cases fail their
rejection assertions. Validly shaped wrong endpoints, wrong mover/mode, excessive/NaN depth,
negative/non-finite time and impossible speed are correctly rejected in the fixture suite.

Validate exactly two finite coordinates in geographic ranges, finite nonnegative depth,
and a finite integer point count with suitable bounds before geometry arithmetic. This is
a defect in internal consistency validation, separate from trusting a client to invent a
well-formed route (the accepted demo limitation below).

### F6 — P2: approval is not bound to the travel estimate shown for review

`dashboard/convex/planner.ts:138` retains only proposed pair membership. A recorded proposal
can say 600 seconds and the approval can supply 3600 seconds for that same pair; no comparison
is made, and actual Convex assigns. No fingerprint or state change is required. Reproduced
in fixtures and real local Convex.

Bind approval evidence to the recorded proposal/reviewed route, allowing the browser's
documented whole-second rounding. Merely checking a plausible lower speed bound does not
ensure the dispatcher approved the same estimate. This check needs no independent rerouter.

### F7 — P2: explanations can describe the wrong tradeoff or the wrong plan

Deterministic explanation: `dashboard/src/lib/planner.ts:263` always says a faster team used
elsewhere serves an incident that ranks the same or higher. Counterexample, times in seconds:

| Incident | Tier | Team A | Team B | Team C |
| --- | --- | --- | --- | --- |
| First | critical | 10 | 100 | no route |
| Second | high | 20 | no route | 30 |
| Third | high | 21 | no route | 31 |

The optimizer correctly assigns B to critical and A/C to the two high incidents: coverage
of the two high incidents beats critical travel time, after critical coverage is preserved.
Its critical explanation incorrectly says the high incident ranks the same or higher.
The independent regression preserves the correct three assignments and rejects the false
reason. The opening UI also says least **total** travel (`AssignmentPlanner.tsx:153`) whereas
the actual objective minimizes travel **by tier** after all three coverage counts.

Async explanation: `AssignmentPlanner.tsx:98` sets summary without checking plan identity.
Generate A, generate B, resolve B's explanation, then resolve A's. A's summary replaces B's
under the current proposals. The actual-component hook harness reproduces this race with
deferred mocked explanations. Scope success and failure callbacks to the matching plan,
as the component already does for successful proposal recording at line 94.

## What passed, and what remains a trust limitation

- The exact allocator matched an independent exhaustive enumerator for **400 seeded**
  matrices (up to six incidents/five teams), including missing routes, exclusions, tiered
  travel objectives, ties and reversed input order. No stranding/nonoptimal-allocation
  counterexample was found in that search. This is not proof over every possible input.
  The declared 12-team/40-incident boundary was accepted; 13 or 41 refused before routing.
- Existing tests cover scarce capabilities, confirmed primary reports only, linked reports,
  assigned/busy/moving teams, unknown routes and visible unknown count/position warnings.
- Wrong/missing dispatcher credentials reject when `DISPATCHER_TOKEN` is configured,
  including receipt retries. Authentication intentionally remains optional when unset.
- Existing tests and eleven independent changed-input fixture cases reject changed risk,
  position, override, caller water, location confirmation/coordinates, team coordinates,
  capability and availability; owner cases also cover risk withdrawals, river changes,
  new incidents and concurrent allocation. F1/F2 identify the remaining omissions.
- Real local Convex verified concurrent approvals have one winner; identical retries do
  not duplicate assignments. The new positive real-runtime test checks recommendation
  has no assignment effects, one invalid member rejects the batch, valid approval uses
  normal assignments and linked caller updates, retry creates no duplicate updates, no
  implicit en-route/resolved status, and hangup preserves the assigned incident.
- Claude stays optional and advisory. Missing key, provider failure and the SDK's actual
  eight-second timeout path retain the fallback and permit approval. Provider transport
  was mocked. The lexical team/number/certainty filter is **not a semantic guarantee**:
  it cannot detect reversed priorities, negation, or unsupported prose using known tokens.
- Stale/rejected database approvals have visible alert text and regeneration controls.
  The component logic failures above concern inputs the UI fails to mark stale and an
  unscoped summary result, not the presence of those error controls.

The server independently reads current exercise/incident/team state, checks its fingerprint,
proposal membership, duplicates, waiting/confirmed primary status, team availability, mover,
allowed modes, profile depth limit, endpoint proximity and a lower travel-time bound; then
writes the batch in one transaction through `assignTeamTo`.

It **trusts** the browser's eligible route matrix, priority computation, optimizer result,
actual road/elevation data, path existence and depth claims. The evidence contains no path,
road/grid version or verifiable road samples. An authenticated client can record a fabricated
proposal and submit a well-shaped fictional route; an independent fixture confirms this is
accepted. Fingerprinting is a state identifier, not a cryptographic attestation. This is an
accepted trusted-demo boundary, not independent route verification, optimality verification,
real-world passability or a safety guarantee. Repairing F5/F6 does not remove this boundary.

## Commands and results

These results refer to the exact application commits above, with only QA overlays. Existing
checks were run separately before adding the intentionally failing regressions.

| Command | Result / scope |
| --- | --- |
| `cd dashboard && npm run test:voice` before QA overlay | 59 passed, 1 local-only skipped; fixtures |
| `backend/.venv/bin/python -m pytest backend/tests -q` | 64 passed, 4 skipped, 17 subtests passed; external services mocked |
| `backend/.venv/bin/python scripts/demo/validate.py --strict --dashboard` | 23 strict handler checks passed; temporary-copy Next typegen, TypeScript and webpack production build passed |
| `cd dashboard && npm run test:priority` | 17 passed |
| `cd dashboard && ./node_modules/.bin/eslint src convex tests` | Passed, including QA additions |
| `cd dashboard && ./node_modules/.bin/tsc --noEmit --incremental false` after temporary-copy `next typegen` | Passed, including QA additions |
| Local runner + `backend/.venv/bin/python -m unittest discover -s backend/tests -v` | 52 run, 51 passed, 1 local classifier-artifact skipped; real local Convex, mocked external services |
| Local runner + `cd dashboard && ./node_modules/.bin/vitest run tests/plannerLive.test.ts` | 1 passed; real concurrent local Convex transactions |
| `cd dashboard && ./node_modules/.bin/vitest run tests/plannerIndependentQa.test.ts` | **26 passed, 15 failed** (41 tests); ordinary failing assertions, no expected-failure masking |
| Local runner + `cd dashboard && ./node_modules/.bin/vitest run tests/plannerIndependentLiveQa.test.ts` | **1 passed, 7 failed**; real Convex validation/transactions and scheduled aircraft arrival |
| `node scripts/qa/planner_panel.cjs` | **4 failed**; actual component logic, mocked hooks/store; not browser verification |

The new real-runtime helicopter test waits for `MIN_TRIP_MS` (12 seconds), rather than
treating a simulated playback callback or a prematurely stopped trip as arrival evidence.
An initial QA harness wait was too short; it was corrected to honor the production timing.
No application assertions were weakened.

Reproduce real Convex checks in a fresh archive/worktree with installed dependencies only:

```sh
# In a disposable candidate copy without .env files, never the running demo checkout:
env -u CONVEX_DEPLOY_KEY -u CONVEX_DEPLOYMENT -u CONVEX_URL \
  LIFELINE_LOCAL_CONVEX_PORT=3660 scripts/integration/local_convex.sh \
  bash -c 'cd dashboard && ./node_modules/.bin/vitest run tests/plannerIndependentLiveQa.test.ts'
```

Choose another free port pair if 3660/3661 is occupied. The runner creates its own secrets
and local storage; it must not be aimed at the existing Convex instance. New live tests
skip unless the runner supplies a localhost URL and test environment. They do not reset
data and resolve only the incidents they create.

## Recommendations and verification limits

- **Merge into dev: hold.** Fix F1–F7 and rerun the unchanged regression assertions. The
  allocation objective itself passed the independent oracle; these blockers concern
  approval integrity, stale review, evidence validation and explanations.
- **Trusted fictional demo: hold use of this planner approval panel** until those fixes.
  The existing manual-assignment path passed regression checks, but that is not approval
  of routing changes or a new deployment. Keep simulation disclosure and make the browser
  route-trust limitation explicit to the dispatcher. Configure the dispatcher passcode if
  access extends beyond the trusted demonstration participants.
- **Future real product: not ready.** Requires server-verifiable/versioned routing and
  priority inputs, substantive dispatch/capacity policy, durable authenticated identities
  and authorization, evidence-bound audit records, operational failure handling, validated
  flood/road assumptions, and human operational validation. Client routes and lexical
  summary filtering cannot serve as those guarantees.

No live Claude/other provider request, Twilio call, microphone, speaker, human panel review,
or actual road/passability verification was performed. The component hook harness does not
verify browser layout, map rendering, visual loading transitions or accessibility. Successful
event queuing is not evidence that anyone heard an announcement. Existing runbook/provider
and human-call evidence remains historical; it was not repeated or counted as this review.

After automated blockers are fixed, a short human panel check should: open fictional
confirmed critical/high/standard reports with one scarce team; inspect route, alternatives,
unknown count/capacity and by-tier tradeoff; exclude/regenerate; change a count, location,
water report and river level and verify approval disables; approve a fresh selected batch;
confirm one normal assignment per primary with linked updates and no en-route transition.
Human signoff must explicitly confirm readability and current-summary coherence. Audio,
if demonstrated, requires a person confirming the exact current approved team was heard;
this review does not claim that pass.
