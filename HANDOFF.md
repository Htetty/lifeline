# Handoff — Flood Rescue Dispatcher

Updated: 2026-10-23. Read `PROJECT_PLAN.md` for the product plan; this file is the current state.

**2026-10-24 voice bridge increment:** See
[`docs/integration/live-voice-dashboard.md`](docs/integration/live-voice-dashboard.md)
for the browser microphone path, isolated startup, authentication changes, and
recorded validation. The existing Managed Agent / Twilio setup is unchanged.
New Convex tables `voiceCalls` and `voiceTurns` provide atomic ordering and retry
receipts. All FastAPI `/calls/*` routes now require the backend bearer secret.
Use fixture tests or the isolated local exercise; the shared reset/regression
commands below are historical and must not be run as part of bridge verification.

## What works now

```
Call (simulated) → FastAPI → Claude Sonnet extracts facts → Convex → Dashboard (live)
                ← spoken update text ← dispatcher approves a team ←┘
```

- **Dashboard** (`dashboard/`, Next.js 16 + MapLibre 6): 3D map of Mission Valley, San Diego with
  real OSM buildings, a simulated flood from USGS ground elevation (water drawn to scale, depth per
  building), red buildings for people awaiting rescue, an incident queue, a detail panel (water vs. building height,
  transcript, hazards with the caller's words), and place-on-map / confirm location / assign team / status
  controls. All data comes live from Convex.
- **Convex** (`dashboard/convex/`): tables `exercises`, `incidents`, `teams`, `activity`, `events`.
  Dashboard functions are in `exercise.ts` and `incidents.ts` and require the dispatcher passcode (`DISPATCHER_TOKEN`). Backend-only functions in `calls.ts` require `BACKEND_SECRET`.
- **Backend** (`backend/`, FastAPI): each utterance goes to Claude (`claude-sonnet-5-5`, effort low,
  structured output, server-side refusal fallback) and is then saved to Convex. Confirmed dispatcher decisions come back
  as announcements with approved wording. See `backend/README.md` for the endpoints.
- **Tested end-to-end on the cloud deployment:** extraction (~3–4 s per line), caller location correction,
  no assignment before the location is confirmed, no double-booking, exactly-once announcement, wrong secret rejected,
  and hanging up leaves the incident open.

## Environment

| Thing | Value |
| --- | --- |
| Convex deployment (shared, production) | `elegant-lark-857`, team "calhacks" — `https://elegant-lark-857.convex.cloud` |
| Unused dev deployment | `scintillating-sturgeon-661` |
| Dashboard dev server | http://localhost:3100 (port 3000 is used by other projects) |
| FastAPI | http://localhost:8000 |
| Secrets (never commit) | `dashboard/.env.local`: `CONVEX_DEPLOY_KEY` (prod). `backend/.env`: `BACKEND_SECRET`, `ANTHROPIC_API_KEY`, `VOICE_BRIDGE_TOKEN`. Convex env: `BACKEND_SECRET`, `DISPATCHER_TOKEN` (typed into the dashboard at sign-in, never bundled) |

Function changes are **not** auto-synced. After editing `dashboard/convex/*.ts`, run `npx convex deploy` in `dashboard/`.
Reset (button or `npx convex run exercise:reset`) wipes the shared data for everyone.

## Run

```bash
cd dashboard && npm install && npx next dev -p 3100
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
# Test a call (type caller lines; then assign a team on the dashboard):
.venv/bin/python scripts/simulate_call.py --interactive --listen 120
# Regression checks for the call rules (add --live to include real Claude calls):
.venv/bin/python scripts/check_call_rules.py --live
```

New teammate: `NEXT_PUBLIC_CONVEX_URL` in `dashboard/.env.local`; `CONVEX_URL`, `BACKEND_SECRET` (shared privately) and
their own `ANTHROPIC_API_KEY` in `backend/.env`. The deploy key is needed only by whoever edits Convex functions.

## Several calls about one place

Claude labels each caller `trapped` or `witness`. Obvious duplicates at the same building (≤35 m) link themselves
(`convex/linking.ts` `autoGroup`, run on every location/position change): same room number; same floor and headcount
when no rooms were given; a witness at a building with one rescue (or only witnesses). Different floors/rooms stay
separate rescues. Uncertain matches are suggested on the dashboard for the dispatcher. Linked reports leave the queue
and map, follow the main incident's team/status, and their callers hear its progress. Every auto-link says why;
Unlink keeps them apart permanently. Backfill existing data: `npx convex run incidents:autoGroupAll`.

## Priority queue

Claude extracts literal risk factors with the caller's words (injury, water at chest, child, in a vehicle…).
`dashboard/src/lib/priority.ts` turns them, plus the water model ("water above their floor"), into
critical / high / standard with reasons. The queue sorts by tier, then longest wait. Factors only accumulate. The
dispatcher can override a tier with a reason. Rule cases: `cd dashboard && npm run test:priority`.

## Tests

Integration tests and the end-to-end walkthrough run on a throwaway local Convex backend, never the shared one:
`scripts/integration/local_convex.sh backend/.venv/bin/python -m unittest discover -s backend/tests -v`.
See `docs/integration/verification.md`.

## Gotchas already solved (don't undo)

- MapLibre CSS forces `position: relative`, so the map is sized from a wrapper div (`FloodMap.tsx`).
- The MapLibre worker is served from `public/maplibre-gl-worker.mjs` (copied by `postinstall`) via `setWorkerUrl`.
- OpenFreeMap merges same-height buildings into one feature, so highlights are drawn per footprint in a GeoJSON overlay,
  not with feature-state.
- The browser extension isn't available. UI was verified with headless Chrome over the DevTools protocol.
- npm is slow and flaky on this network. Use `--fetch-retries=5`.

## Known limits

- The flood is a bathtub model (one water level, connected low ground), not a hydraulic model. Ground elevation is from 2005.
- OSM building heights are sometimes defaults. Floors assume ~3 m.
- Backend transcripts are kept in memory per process (Convex has the saved copy). Restarting FastAPI mid-call
  starts a new transcript for that call.

## Next steps

1. **Cartesia voice** (Person 1): connect one WebSocket per call to `/calls/{id}/stream` (protocol in
   `backend/README.md`). Send utterances, keep the pushed `status` in context, speak pushed `announcement`s at pauses,
   then `ack`. `scripts/simulate_call.py` is a working reference client.
2. **Address lookup (done, basic):** Claude writes map-search queries for the building the caller is *in*. The backend
   searches OSM Nominatim (`backend/app/geocode.py`, free, 1 req/s) and places precise matches (hotels, businesses,
   house numbers) as an unverified candidate, so the building turns red automatically. Streets, areas and "next to X" stay
   for the dispatcher to place. Upgrade to Mapbox if coverage is too thin.
3. **Want, not need:** recommended team + route (Openrouteservice) for one-click dispatcher approval.
4. Before the demo: freeze features, reset data, and rehearse the opening scenario (3 people upstairs → assign → caller hears it).
