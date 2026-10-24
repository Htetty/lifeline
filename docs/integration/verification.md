# Integration verification

All runs below used a disposable local Convex backend (`scripts/integration/local_convex.sh`). It runs on its own
port, refuses to start if a deploy key or a non-local deployment is configured, and stops the backend afterwards.
Nothing touched the shared `elegant-lark-857` deployment, and nothing was deployed or reset there. All call data is
fictional.

## What was verified, and how

These results are from the merged branch: dev, PR #6 (ModernBERT), PR #7 (tests and runbook), and the local
`codex/live-voice-dashboard` commits `b18b4f6` and `39065e3`.

| Level | What is real | What is mocked | Result |
| --- | --- | --- | --- |
| **A. Integration regression suite**: `backend/tests/test_integration.py` | FastAPI routes and auth, Convex client, every Convex query and mutation on a local backend, OCC concurrency | Claude, map search, ModernBERT, audio | 24/24 pass |
| **A′. Mutation check** | Same as A | Same as A | Each of 11 fixes reverted one at a time; every revert fails a named test |
| **B. Owner suites** | Demo harness: real handlers in memory. Voice owner's suites: `convex-test` and FastAPI with fakes | Claude, Convex network, audio | `scripts/demo/validate.py`: 20 pass, 2 expected failures (open retraction policy). Voice owner's Convex tests in `dashboard/tests/calls.test.ts` (vitest): 7/7. `pytest backend/tests`: 28 pass, 2 skipped (local-only modules) |
| **C. Dashboard walkthrough**: `scripts/integration/e2e_local.sh` | uvicorn backend, **live Claude**, live OSM map search, local Convex, Next.js dashboard clicked in headless Chrome | **Audio**: typed caller text, printed announcements; the bridge's poll and ack are scripted | Pass. `evidence/trace.json`, `evidence/*.jpg` |
| **D. Live provider audio**: `backend/scripts/exercise_voice_bridge.py` | Merged `/voice/socket` bridge, **live Cartesia STT and TTS**, live Claude, local Convex | **Caller microphone**: TTS of fictional lines streamed in. **Speaker**: playback completion simulated. Dispatcher actions are scripted Convex calls | Pass. `evidence/cartesia-bridge-exercise.txt` |
| **E. Live ModernBERT** | Real model `disaster_49320174` (torch 2.6 CPU) through the backend and local Convex | Claude | Tags `request`, `floods` stored in `advisoryTags` about 5 s after a 0.01 s utterance response; facts unchanged |
| **F. Human audio**: physical microphone, browser speaker, a person hearing it; or a phone call | n/a | n/a | **Not verified.** Needs a person at the browser voice page. Phone calls are blocked on PR #2 (F1) |

Commands:
- A: `scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -p test_integration.py -v`
- C: `ANTHROPIC_API_KEY=... scripts/integration/e2e_local.sh <out-dir>`
- D: inside `local_convex.sh`, start uvicorn on a free port, then run
  `backend/scripts/exercise_voice_bridge.py --api http://127.0.0.1:<port> --convex-url "$CONVEX_URL" --backend-secret-file <file>`
  with `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID` and `ANTHROPIC_API_KEY` exported. Pass the URLs explicitly: the
  defaults (8010, 3210) may belong to someone else's running instances.

## Walkthrough C (`evidence/trace.json`)

1. The agent greeting is stored but creates no incident (`saved: false`).
2. Caller: "Days Inn on Hotel Circle South, three of us, water coming up the stairs". Claude extracts 3 people,
   second floor, and the hazard with the caller's words. Map search matches the Days Inn.
3. Caller corrects: "actually the Handlery Hotel … two of us, not three". The **same incident** is updated
   (`location_changed: true`). The new candidate is the Handlery Hotel, and the earlier count and address are kept
   under "Changed by caller" (`evidence/1-incident-after-correction.jpg`).
4. The bridge polls before any decision and gets nothing.
5. On the dashboard, a wrong passcode is rejected. The dispatcher signs in, confirms the location, and approves Swift
   Water Boat 1. Then they unassign it and approve High-Water Truck 7 (`evidence/2-reassigned.jpg`).
6. The bridge polls and gets **one** update, naming High-Water Truck 7. The stale Boat 1 update is never returned.
7. The scripted bridge treats playback as "interrupted", so there's no ack. The re-poll returns the same update. After playback completes, the
   ack gives `acknowledged: true` and nothing is left pending.
8. En route is announced and acked. `/status` reports `en_route` with the team, which gives a truthful answer to "is
   someone coming?".
9. The caller hangs up. The dispatcher resolves the incident. No announcement is returned after hang-up, and the
   incident is kept as Resolved with "Call ended" (`evidence/3-after-hangup-resolved.jpg`).

Checked afterwards:
- None of the 60 built dashboard JS files contain a token value, and neither do the backend or dashboard logs.
- The only browser console messages were missing-sprite warnings from the basemap. These were already there before
  this branch.
