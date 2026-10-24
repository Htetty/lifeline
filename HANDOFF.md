# Handoff — Flood Rescue Dispatcher

Updated: 2026-10-23. Read `PROJECT_PLAN.md` for the product plan; this file is the current state.

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
  Dashboard functions are in `exercise.ts` and `incidents.ts`. Backend-only functions in `calls.ts` require `BACKEND_SECRET`.
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
| Secrets (never commit) | `dashboard/.env.local`: `CONVEX_DEPLOY_KEY` (prod). `backend/.env`: `BACKEND_SECRET`, `ANTHROPIC_API_KEY` |

Function changes are **not** auto-synced. After editing `dashboard/convex/*.ts`, run `npx convex deploy` in `dashboard/`.
Reset (button or `npx convex run exercise:reset`) wipes the shared data for everyone.

## Run

```bash
cd dashboard && npm install && npx next dev -p 3100
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
# Test a call (type caller lines; then assign a team on the dashboard):
.venv/bin/python scripts/simulate_call.py --interactive --listen 120
```

New teammate: `NEXT_PUBLIC_CONVEX_URL` in `dashboard/.env.local`; `CONVEX_URL`, `BACKEND_SECRET` (shared privately) and
their own `ANTHROPIC_API_KEY` in `backend/.env`. The deploy key is needed only by whoever edits Convex functions.

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

1. **Cartesia voice** (Person 1): stream the mic → Cartesia STT → `POST /calls/{id}/utterances`. Speak `next_question`;
   at pauses, `GET /calls/{id}/announcements`, speak the text, then `POST .../ack`. Confirm the Cartesia integration approach
   (agent framework) before building.
2. **Address lookup**: geocode `reportedAddress` in the backend (Mapbox, per the plan) and pass candidate coordinates
   (`candidateLatitude/Longitude` already exist in `calls:upsertFromCall`). They are never auto-verified.
3. **Want, not need:** recommended team + route (Openrouteservice) for one-click dispatcher approval.
4. Before the demo: freeze features, reset data, and rehearse the opening scenario (3 people upstairs → assign → caller hears it).
