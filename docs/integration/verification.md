# Integration verification

All runs below used a disposable local Convex backend (`scripts/integration/local_convex.sh`). It runs on its own
port, refuses to start if a deploy key or a non-local deployment is configured, and stops the backend afterwards.
Nothing touched the shared `elegant-lark-857` deployment, and nothing was deployed or reset there. All call data is
fictional.

## What was verified, and how

| Level | What is real | What is mocked | Result |
| --- | --- | --- | --- |
| **A. Regression suite**: `backend/tests/test_integration.py` (24 tests) | FastAPI routes and auth, Convex client, every Convex query and mutation, OCC concurrency | Claude, map search, ModernBERT, audio | 24/24 pass |
| **A′. Mutation check** | Same as A | Same as A | Each of 11 fixes reverted one at a time; every revert fails at least one test |
| **B. Existing rules**: `backend/scripts/check_call_rules.py` (Convex part) | Convex functions | No Claude | 9/9 pass |
| **C. End-to-end walkthrough**: `scripts/integration/e2e_local.sh` | uvicorn backend, **live Claude extraction**, live OSM map search, local Convex, Next.js dashboard clicked in headless Chrome | **Audio**: caller speech is typed text and announcements are printed, standing in for Cartesia STT/TTS | Pass. See `evidence/` |
| **D. Live audio** (mic → Cartesia STT → backend → TTS → speaker, or a phone call) | n/a | n/a | **Not verified.** Blocked: the voice bridge's `app/voice.py` doesn't exist (F2), and PR #2's phone tools don't write to Convex (F1) |

Run A: `scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -v`
Run C: `ANTHROPIC_API_KEY=... scripts/integration/e2e_local.sh <out-dir>`

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
7. Playback is "interrupted", so there's no ack. The re-poll returns the same update. After playback completes, the
   ack gives `acknowledged: true` and nothing is left pending.
8. En route is announced and acked. `/status` reports `en_route` with the team, which gives a truthful answer to "is
   someone coming?".
9. The caller hangs up. The dispatcher resolves the incident. No announcement is returned after hang-up, and the
   incident is kept as Resolved with "Call ended" (`evidence/3-after-hangup-resolved.jpg`).

Checked afterwards:
- None of the 60 built dashboard JS files contain a token value, and neither do the backend or dashboard logs.
- The only browser console messages were missing-sprite warnings from the basemap. These were already there before
  this branch.
