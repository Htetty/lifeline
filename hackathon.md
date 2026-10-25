# Hackathon log

- **Project:** Lifeline
- **Event:** Cal Hacks 13.0
- **What it does:** Collects spoken flood reports for dispatcher review, mapping, and rescue coordination.
- **Live app:** not deployed
- **Repo:** https://github.com/Htetty/lifeline
- **Frontend:** not deployed
- **Convex deployment:** https://elegant-lark-857.convex.cloud (documented in HANDOFF.md)
- **Components:** none
- **Convex features:** schema, indexes, queries, mutations, actions, scheduled functions, realtime useQuery
- **Auth:** Other (optional dispatcher passcode and voice bearer token)
- **AI models:** claude-sonnet-5-5, claude-haiku-5-5, ink-2, sonic-3.6 (fallback), answerdotai/ModernBERT-base (optional)
- **Started:** 2026-10-24T01:09:33Z
- **Last updated:** 2026-10-25T13:35:47Z

## How we use Convex

- Live queue, map, detail sheet, teams, and activity update without refresh via useQuery: dashboard/src/lib/store.ts.
- Caller facts and correction history use indexed tables and mutations: dashboard/convex/schema.ts, dashboard/convex/calls.ts.
- Assignment review uses mutations to validate and atomically approve proposals: dashboard/convex/planner.ts.
- Team arrivals and simulated rescue completion use an action and scheduled mutations: dashboard/convex/trips.ts.
- Spoken dispatcher updates use stored events and queries; the console's update history uses useQuery: dashboard/convex/callerUpdates.ts, dashboard/src/components/Dashboard.tsx.

## Log

Feature/correctness milestones; merge-only commits omitted. Dates UTC. Paths: c = dashboard/convex; b = backend/app; s = dashboard/src.

- 2026-10-24 e443f3a Scaffold; package.json
- 2026-10-24 8617cbe ML training; ml/scripts/train.py
- 2026-10-24 29980da Live map; c/schema.ts, s/lib/store.ts
- 2026-10-24 0220558 Dataset audit; ml/scripts/audit_data.py
- 2026-10-24 ba8bfb0 Intake; b/extraction.py, c/calls.ts
- 2026-10-24 342cc34 Location pins; c/incidents.ts
- 2026-10-24 1c98272 Call rules; c/calls.ts
- 2026-10-24 05e69ff Advisory tags; b/classifier.py
- 2026-10-24 5d8b8ef Integration checks; tests/integration/test_demo_flow.py
- 2026-10-24 b18b4f6 Voice bridge; b/voice.py, c/schema.ts
- 2026-10-24 a1ac77c Access checks; c/lib.ts
- 2026-10-24 39065e3 Speech settings; b/voice_provider.py
- 2026-10-24 3cc348a Live call status; c/callerUpdates.ts
- 2026-10-24 c925259 Separate rescues; c/incidents.ts
- 2026-10-24 2b0d862 Priority/grouping; c/linking.ts
- 2026-10-24 a55ae50 Phone audio; b/twilio_media.py
- 2026-10-24 e272e7c Optional access; c/lib.ts
- 2026-10-24 802e57e Approved replay; c/calls.ts
- 2026-10-24 6d6ac3c Named locations; b/geocode.py
- 2026-10-24 5cfc7e5 Caller intent; b/extraction.py
- 2026-10-24 0822927 Retractions; c/calls.ts
- 2026-10-24 77f387b Grouping checks; c/linking.ts
- 2026-10-24 1be9fdf Gauge/trips; c/trips.ts
- 2026-10-24 014233e Flood routes; s/lib/router.ts
- 2026-10-24 6a246b3 Water reports; c/waterReports.ts
- 2026-10-24 aeb154b Phone turns; b/twilio_media.py
- 2026-10-24 6f1770b Queued turns; b/voice.py
- 2026-10-25 9a25cb7 Flow fixes; c/tripMath.ts
- 2026-10-25 845aed6 Empty reset; c/exercise.ts
- 2026-10-25 d6356b3 Queue planner; c/planning.ts
- 2026-10-25 e499a81 Atomic approval; c/planner.ts
- 2026-10-25 d8d386f Approval fixes; c/planner.ts
- 2026-10-25 a8572b6 Route review; c/planner.ts
- 2026-10-25 9d9bac1 Depth estimates; c/waterReports.ts
- 2026-10-25 6514a9b Smooth movement; s/components/FloodMap.tsx
- 2026-10-25 b255014 Review panel; s/components/AssignmentPlanner.tsx
- 2026-10-25 fbef313 Location consent; b/location_share.py
- 2026-10-25 5ddb083 Simulation; c/simulation.ts
- 2026-10-25 00c919d Save caller fix; c/calls.ts
- 2026-10-25 0082618 Regions; c/regions.ts
- 2026-10-25 bd3b935 Golden Gate; c/regions.ts
- 2026-10-25 4a9acad Boat obstacles; s/lib/router.ts
- 2026-10-25 e3bf9e8 Demo controls; b/simulation.py
