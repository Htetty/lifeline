"use client";

import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_AREA } from "@/data/fixtures";
import { loadElevation, type ElevationGrid } from "@/lib/elevation";
import {
  buildFloodGrid,
  channelDepth,
  computeFlood,
  depthAt,
  FLOOR_HEIGHT_M,
  isFlooded,
  OBSERVATION_RADIUS_M,
  observationAt,
  surfaceAtPoint,
  waterAtBuilding,
  type FloodGrid,
  type FloodResult,
  type WaterObservation,
} from "@/lib/flood";
import { formatGaugeTime, GAUGE, readingAt, readingIndex, REPLAY_LENGTH, surfaceToStage } from "@/lib/gauge";
import {
  deepestAhead,
  loadRoads,
  moverFor,
  planRoute,
  PROFILES,
  ROUTE_COLOR,
  type NoRoute,
  type RoadGraph,
  type RoutePlan,
} from "@/lib/router";
import {
  currentDispatcherToken,
  dispatch,
  errorMessage,
  useDispatcherToken,
  useExercise,
  usePasscodeRequired,
  type Action,
  type TripPlan,
} from "@/lib/store";
import type { ExerciseState, Incident, IncidentStatus, PriorityTier, RescueTeam } from "@/lib/types";
import { ACTIVE_STATUSES, DISPATCHED_STATUSES, STATUS_LABEL } from "@/lib/types";
import { buildingSummary, isOpen, nearbyReports, pickMain, type NearbyReport } from "@/lib/grouping";
import { computePriority, FACTOR_LABEL, TIER_RANK, type Priority } from "@/lib/priority";
import type { BuildingPick, ResolvedBuilding } from "./FloodMap";
import { TRIP_SPEEDUP, tripProgress } from "../../convex/tripMath";
import { LEVEL_LABEL } from "../../convex/waterReports";

const FloodMap = dynamic(() => import("./FloodMap"), { ssr: false });

type Filter = "all" | "stuck" | "dispatched" | "resolved";
type Run = (action: Action) => void;

interface TeamOption {
  team: RescueTeam;
  /** null while the roads or flood are still loading. */
  plan: RoutePlan | NoRoute | null;
}

interface RouteAlert {
  team: RescueTeam;
  deepest: number;
  limit: number;
  label: string;
}

const asTripPlan = (p: RoutePlan): TripPlan => ({ path: p.path, legs: p.legs, realSeconds: p.realSeconds });

const FILTERS: Record<Filter, (s: IncidentStatus) => boolean> = {
  all: () => true,
  stuck: (s) => ACTIVE_STATUSES.includes(s),
  dispatched: (s) => DISPATCHED_STATUSES.includes(s),
  resolved: (s) => s === "resolved",
};

const STATUS_STYLE: Record<IncidentStatus, { icon: string; cls: string }> = {
  needs_review: { icon: "?", cls: "bg-red-100 text-red-800 ring-red-300" },
  awaiting_assignment: { icon: "!", cls: "bg-red-100 text-red-800 ring-red-300" },
  assigned: { icon: "→", cls: "bg-amber-100 text-amber-900 ring-amber-300" },
  en_route: { icon: "»", cls: "bg-amber-100 text-amber-900 ring-amber-300" },
  resolved: { icon: "✓", cls: "bg-green-100 text-green-800 ring-green-300" },
};

// Water surface at the gauge, metres NAVD88: normal flow is ~6 m, the 2017 record ~9.3 m.
const WATER_MIN = 5.5;
const WATER_MAX = 12;
const WATER_COMMIT_MS = 150;
// Each tick replays 30 minutes of the storm (two 15-minute gauge readings).
const REPLAY_TICK_MS = 3000;
const READINGS_PER_TICK = 2;
const TEAM_UPDATE_EVERY_TICKS = 3;
const CLOCK_MS = 2000;

function fmt(m: number | null, digits = 1) {
  return m == null ? "unknown" : `${m.toFixed(digits)} m`;
}

export default function Dashboard() {
  const { token, signIn } = useDispatcherToken();
  const passcodeRequired = usePasscodeRequired();
  if (passcodeRequired === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Connecting to Convex…
      </div>
    );
  }
  // Open demo by default; a passcode form only appears if the deployment sets DISPATCHER_TOKEN.
  if (passcodeRequired && !token) return <PasscodeGate signIn={signIn} />;
  return <SignedInDashboard token={token ?? ""} />;
}

function PasscodeGate({ signIn }: { signIn: (token: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-sm text-slate-200">
      <form
        className="w-72 space-y-3 rounded bg-slate-900 p-5 ring-1 ring-slate-700"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          signIn(value.trim()).catch((err) => setError(errorMessage(err)));
        }}
      >
        <h1 className="font-semibold">Dispatcher sign-in</h1>
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Dispatcher passcode"
          placeholder="Dispatcher passcode"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded bg-slate-800 px-2 py-1.5 ring-1 ring-slate-600"
        />
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button type="submit" disabled={!value.trim()} className="w-full rounded bg-sky-500 py-1.5 font-semibold text-slate-950 disabled:opacity-50">
          Sign in
        </button>
      </form>
    </div>
  );
}

function SignedInDashboard({ token }: { token: string }) {
  const state = useExercise(token);
  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Connecting to Convex…
      </div>
    );
  }
  return <DashboardView state={state} />;
}

function DashboardView({ state }: { state: ExerciseState }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [reportMode, setReportMode] = useState(false);
  /** Incident being placed on the map (calls arrive without coordinates). */
  const [placingFor, setPlacingFor] = useState<string | null>(null);
  const [pendingPick, setPendingPick] = useState<BuildingPick | null>(null);
  const [liveFeed, setLiveFeed] = useState(false);
  const [elevation, setElevation] = useState<ElevationGrid | null>(null);
  const [elevationError, setElevationError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, ResolvedBuilding>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [waterDraft, setWaterDraft] = useState<number | null>(null);
  const [roads, setRoads] = useState<RoadGraph | null>(null);
  /** Team whose route is previewed for an incident. */
  const [preview, setPreview] = useState<{ incidentId: string; teamId: string } | null>(null);
  /** Team the map shows and follows; `key` lets the same team be re-centred. */
  const [focusTeam, setFocusTeam] = useState<{ id: string; key: number } | null>(null);
  /** Clock for where moving teams are, refreshed while any team is travelling. */
  const [now, setNow] = useState(() => Date.now());

  const run: Run = useCallback((action) => {
    dispatch(action).catch((e) => setToast(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // The slider updates the map immediately and saves to Convex at most every 150 ms.
  const waterLevel = waterDraft ?? state.waterSurfaceElevation;
  useEffect(() => {
    if (waterDraft == null) return;
    const t = setTimeout(() => {
      dispatch({ type: "setWaterLevel", meters: waterDraft })
        .catch((e) => setToast(errorMessage(e)))
        .finally(() => setWaterDraft((d) => (d === waterDraft ? null : d)));
    }, WATER_COMMIT_MS);
    return () => clearTimeout(t);
  }, [waterDraft]);

  useEffect(() => {
    loadElevation(DEMO_AREA.floodBounds)
      .then(setElevation)
      .catch((e: Error) => setElevationError(e.message));
    loadRoads()
      .then(setRoads)
      .catch((e: Error) => setToast(`Routing unavailable: ${e.message}`));
  }, []);

  const grid: FloodGrid | null = useMemo(
    () => (elevation ? buildFloodGrid(elevation, DEMO_AREA.floodBounds, GAUGE.longitude) : null),
    [elevation],
  );
  // Callers' descriptions of the water, placed where they are.
  const observations: WaterObservation[] = useMemo(() => {
    if (!grid) return [];
    return state.incidents.flatMap((i) => {
      if (!i.waterReport || i.latitude == null || i.longitude == null) return [];
      const at = observationAt(grid, i.waterReport, i.longitude, i.latitude, FLOOR_HEIGHT_M);
      return at ? [{ lon: i.longitude, lat: i.latitude, ...at, weight: i.locationVerified ? 1 : 0.5 }] : [];
    });
  }, [grid, state.incidents]);
  const callerZones = useMemo(
    () =>
      state.incidents.flatMap((i) =>
        i.waterReport && i.latitude != null && i.longitude != null && !i.linkedTo
          ? [{ lon: i.longitude, lat: i.latitude, label: `Caller: ${LEVEL_LABEL[i.waterReport.level]}` }]
          : [],
      ),
    [state.incidents],
  );
  // The river model alone, and corrected by what callers report.
  const riverFlood = useMemo(() => (grid ? computeFlood(grid, waterLevel) : null), [grid, waterLevel]);
  const flood = useMemo(
    () => (grid && observations.length ? computeFlood(grid, waterLevel, observations) : riverFlood),
    [grid, waterLevel, observations, riverFlood],
  );
  const depthOverChannel = grid ? Math.max(0, channelDepth(grid, waterLevel)) : null;
  const observedAt = waterDraft == null ? state.waterObservedAt : null;

  const waterReport = useCallback(
    (incident: Incident) => {
      if (!elevation || !grid || !flood || incident.latitude == null || incident.longitude == null) return null;
      const ground = elevation.sample(incident.longitude, incident.latitude);
      const wet = isFlooded(grid, flood, incident.longitude, incident.latitude);
      const surface = surfaceAtPoint(grid, flood, incident.longitude, incident.latitude);
      return waterAtBuilding(ground, surface, wet, resolved[incident.id]?.height ?? null);
    },
    [elevation, grid, flood, resolved],
  );

  /** Fastest flood-aware route for a team to an incident, from where the team is now. */
  const planFor = useCallback(
    (team: RescueTeam, incident: Incident, at: number): RoutePlan | NoRoute | null => {
      if (!roads || !grid || !flood || incident.latitude == null || incident.longitude == null) return null;
      const [longitude, latitude] = team.trip ? tripProgress(team.trip, at).position : [team.longitude, team.latitude];
      return planRoute(
        roads,
        grid,
        flood,
        { longitude, latitude, capabilities: team.capabilities },
        { longitude: incident.longitude, latitude: incident.latitude },
      );
    },
    [roads, grid, flood],
  );
  const planForRef = useRef(planFor);
  useEffect(() => {
    planForRef.current = planFor;
  }, [planFor]);

  // Replays the recorded storm at the gauge and sets assigned teams off.
  // New calls come from the FastAPI backend (backend/scripts/simulate_call.py).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    if (!liveFeed) return;
    let tick = 0;
    const timer = setInterval(() => {
      const s = stateRef.current;
      tick++;
      const current = readingIndex(s.waterObservedAt);
      if (current < REPLAY_LENGTH - 1) {
        const next = readingAt(current < 0 ? 0 : current + READINGS_PER_TICK);
        run({ type: "setWaterLevel", meters: next.surface, observedAt: next.time });
      }
      const assigned = s.incidents.find((i) => i.status === "assigned" && !i.linkedTo);
      if (tick % TEAM_UPDATE_EVERY_TICKS === 0 && assigned) {
        const team = s.teams.find((t) => t.id === assigned.assignedTeamId);
        const plan = team ? planForRef.current(team, assigned, Date.now()) : null;
        // A team with no safe way in stays put for the dispatcher to reassign.
        if (plan?.ok) run({ type: "setStatus", incidentId: assigned.id, status: "en_route", plan: asTripPlan(plan) });
      }
    }, REPLAY_TICK_MS);
    return () => clearInterval(timer);
  }, [liveFeed, run]);

  const onReportBuilding = useCallback(
    (pick: BuildingPick) => {
      if (placingFor) {
        run({ type: "verifyLocation", incidentId: placingFor, latitude: pick.latitude, longitude: pick.longitude });
        setSelectedId(placingFor);
        setPlacingFor(null);
        return;
      }
      setPendingPick(pick);
      setSelectedId(null);
    },
    [placingFor, run],
  );

  // Linked reports are about the same people as their main incident: list, map and count it once.
  const mainIncidents = useMemo(() => state.incidents.filter((i) => !i.linkedTo), [state.incidents]);
  const linkedCount = (id: string) => state.incidents.filter((i) => i.linkedTo === id).length;
  const priorities = useMemo(
    () =>
      new Map<string, Priority>(
        mainIncidents.map((i) => [
          i.id,
          computePriority(
            i,
            state.incidents.filter((r) => r.linkedTo === i.id),
            waterReport(i),
          ),
        ]),
      ),
    [mainIncidents, state.incidents, waterReport],
  );
  // Waiting incidents: most urgent tier first, then whoever has waited longest, then more people.
  const incidents = [...mainIncidents]
    .filter((i) => FILTERS[filter](i.status))
    .sort((a, b) => {
      const group = (i: Incident) =>
        ACTIVE_STATUSES.includes(i.status) ? 0 : DISPATCHED_STATUSES.includes(i.status) ? 1 : 2;
      const tier = (i: Incident) => TIER_RANK[priorities.get(i.id)?.tier ?? "standard"];
      if (group(a) !== group(b)) return group(a) - group(b);
      if (group(a) === 2) return b.updatedAt - a.updatedAt;
      return tier(a) - tier(b) || a.createdAt - b.createdAt || (b.peopleCount ?? 0) - (a.peopleCount ?? 0);
    });
  const mapState = useMemo(
    () => ({
      ...state,
      incidents: mainIncidents.map((i) => ({ ...i, priorityTier: priorities.get(i.id)?.tier })),
      waterSurfaceElevation: waterLevel,
    }),
    [state, mainIncidents, priorities, waterLevel],
  );
  const criticalWaiting = mainIncidents.filter(
    (i) => ACTIVE_STATUSES.includes(i.status) && priorities.get(i.id)?.tier === "critical",
  ).length;
  const selected = state.incidents.find((i) => i.id === selectedId) ?? null;

  // Teams that could go to the selected incident, fastest first.
  const teamOptions: TeamOption[] = useMemo(() => {
    if (!selected || selected.linkedTo) return [];
    return state.teams
      .filter((t) => t.available || t.id === selected.assignedTeamId)
      .map((team) => ({ team, plan: planFor(team, selected, now) }))
      .sort((a, b) => {
        const time = (o: TeamOption) => (o.plan?.ok ? o.plan.realSeconds : Infinity);
        return time(a) - time(b) || a.team.name.localeCompare(b.team.name);
      });
  }, [selected, state.teams, planFor, now]);

  // Show the chosen team's route, or the fastest one, until a team sets off.
  const previewPlan = useMemo(() => {
    if (!selected || !["awaiting_assignment", "assigned"].includes(selected.status)) return null;
    const chosen =
      selected.status === "assigned"
        ? selected.assignedTeamId
        : preview?.incidentId === selected.id
          ? preview.teamId
          : teamOptions.find((o) => o.plan?.ok)?.team.id;
    const plan = teamOptions.find((o) => o.team.id === chosen)?.plan;
    return plan?.ok ? { path: plan.path, legs: plan.legs } : null;
  }, [selected, preview, teamOptions]);

  // Whether rising water has cut the remaining route of the team heading to the selected incident.
  const routeAlert: RouteAlert | null = useMemo(() => {
    if (!selected || !roads || !grid || !flood) return null;
    const team = state.teams.find((t) => t.id === selected.assignedTeamId);
    if (!team?.trip) return null;
    const mover = moverFor(team.capabilities);
    if (mover === "air") return null;
    const { limit, label } = PROFILES[mover];
    const deepest = deepestAhead(roads, grid, flood, team.trip, now);
    return deepest > limit ? { team, deepest, limit, label } : null;
  }, [selected, state.teams, roads, grid, flood, now]);

  const anyTrip = state.teams.some((t) => t.trip);
  useEffect(() => {
    if (!anyTrip) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [anyTrip]);
  const placing = state.incidents.find((i) => i.id === placingFor) ?? null;
  const stuckPeople = mainIncidents
    .filter((i) => ACTIVE_STATUSES.includes(i.status))
    .reduce((n, i) => n + (i.peopleCount ?? 0), 0);


  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center gap-4 border-b border-slate-800 px-4 py-2.5">
        <h1 className="text-base font-semibold tracking-tight">Flood Rescue Dispatcher</h1>
        <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-slate-950">
          Simulated exercise
        </span>
        <span className="text-sm text-slate-400">{DEMO_AREA.name}</span>
        <div className="ml-auto flex items-center gap-4 text-sm">
          {criticalWaiting > 0 && (
            <span className="rounded bg-red-600 px-2 py-0.5 font-semibold">{criticalWaiting} critical waiting</span>
          )}
          <span>
            <b className="text-red-400">{stuckPeople}</b> people awaiting rescue
          </span>
          <span className="text-slate-400" title={`USGS ${GAUGE.site} ${GAUGE.name}`}>
            River gauge <b className="text-sky-300">{surfaceToStage(waterLevel).toFixed(1)} ft</b>
            {observedAt != null ? ` · ${formatGaugeTime(observedAt)}` : " · set by hand"}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: controls, queue, activity */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-slate-800">
          <section className="space-y-3 border-b border-slate-800 p-4">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
              River level at Fashion Valley gauge
            </label>
            <input
              type="range"
              min={WATER_MIN}
              max={WATER_MAX}
              step={0.05}
              value={waterLevel}
              onChange={(e) => setWaterDraft(Number(e.target.value))}
              className="w-full accent-sky-400"
            />
            <p className="text-xs text-slate-400">
              {surfaceToStage(waterLevel).toFixed(2)} ft gauge height ({waterLevel.toFixed(2)} m above sea level)
              {depthOverChannel != null && <> · {depthOverChannel.toFixed(1)} m above the river channel</>}
            </p>
            <p className="text-[10px] leading-snug text-slate-500">
              {observedAt != null
                ? `Recorded by USGS gauge ${GAUGE.site} at ${formatGaugeTime(observedAt)} during the ${GAUGE.event}.`
                : `Set by hand. Replay uses USGS gauge ${GAUGE.site} readings from the ${GAUGE.event}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setLiveFeed((v) => !v)}
                className={`rounded px-2.5 py-1.5 text-xs font-medium ${
                  liveFeed ? "bg-emerald-500 text-slate-950" : "bg-slate-800 hover:bg-slate-700"
                }`}
              >
                {liveFeed ? "● Replaying 2017 storm" : "Replay 2017 storm"}
              </button>
              <button
                onClick={() => {
                  setReportMode((v) => !v);
                  setPlacingFor(null);
                  setPendingPick(null);
                }}
                className={`rounded px-2.5 py-1.5 text-xs font-medium ${
                  reportMode && !placingFor ? "bg-red-500 text-white" : "bg-slate-800 hover:bg-slate-700"
                }`}
              >
                {reportMode && !placingFor ? "Click a building… (cancel)" : "+ Mark stuck people"}
              </button>
              <button
                onClick={() => {
                  if (!confirm("Restore the initial exercise data for everyone?")) return;
                  setLiveFeed(false);
                  setSelectedId(null);
                  setPendingPick(null);
                  setPlacingFor(null);
                  run({ type: "reset" });
                }}
                className="rounded bg-slate-800 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-700"
              >
                Reset
              </button>
            </div>
          </section>

          <section className="flex gap-1 border-b border-slate-800 px-4 py-2">
            {(Object.keys(FILTERS) as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs capitalize ${
                  filter === f ? "bg-slate-200 text-slate-900" : "text-slate-400 hover:bg-slate-800"
                }`}
              >
                {f}
              </button>
            ))}
          </section>

          <ul className="min-h-0 flex-1 overflow-y-auto">
            {incidents.map((i) => {
              const w = waterReport(i);
              const st = STATUS_STYLE[i.status];
              return (
                <li key={i.id}>
                  <button
                    onClick={() => {
                      setSelectedId(i.id);
                      setPendingPick(null);
                    }}
                    className={`block w-full border-b border-slate-900 px-4 py-3 text-left hover:bg-slate-900 ${
                      i.id === selectedId ? "bg-slate-800" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      {i.status !== "resolved" && <TierPill priority={priorities.get(i.id)} />}
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${st.cls}`}>
                        {st.icon} {STATUS_LABEL[i.status]}
                      </span>
                      {i.latitude == null ? (
                        <span className="rounded bg-yellow-300 px-1.5 py-0.5 text-[11px] font-semibold text-slate-900">
                          Not on map
                        </span>
                      ) : (
                        !i.locationVerified && (
                          <span className="rounded bg-yellow-300 px-1.5 py-0.5 text-[11px] font-semibold text-slate-900">
                            {i.locationNote?.startsWith("Map search") ? "Auto-located · confirm" : "Location unverified"}
                          </span>
                        )
                      )}
                      {i.callConnected && (
                        <span className="rounded bg-emerald-400 px-1.5 py-0.5 text-[11px] font-semibold text-slate-900">
                          ● On call
                        </span>
                      )}
                      <GroupBadges incident={i} all={state.incidents} linked={linkedCount(i.id)} />
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{i.reportedAddress}</p>
                    {i.status !== "resolved" && !!priorities.get(i.id)?.reasons.length && (
                      <p className="mt-0.5 text-xs text-red-300">{priorities.get(i.id)!.reasons.slice(0, 3).join(" · ")}</p>
                    )}
                    <p className="mt-0.5 text-xs text-slate-400">
                      {i.peopleCount ?? "?"} {i.peopleCount === 1 ? "person" : "people"}
                      {i.reportedPosition ? ` · ${i.reportedPosition}` : ""}
                      {w?.depth != null ? ` · ${w.depth.toFixed(1)} m water` : ""}
                    </p>
                  </button>
                </li>
              );
            })}
            {!incidents.length && <li className="p-4 text-sm text-slate-500">No incidents match this filter.</li>}
          </ul>

          <section className="max-h-40 overflow-y-auto border-t border-slate-800 p-3">
            <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Activity</h2>
            <ul className="space-y-1 text-xs text-slate-300">
              {state.activity.slice(0, 12).map((a) => (
                <li key={a.id}>
                  <span className="text-slate-500">
                    {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>{" "}
                  {a.message}
                </li>
              ))}
            </ul>
          </section>
        </aside>

        {/* Map */}
        <main className="relative min-w-0 flex-1">
          <FloodMap
            state={mapState}
            flood={flood}
            preview={previewPlan}
            selectedId={selectedId}
            reportMode={reportMode || placingFor != null}
            onSelect={(id) => {
              setSelectedId(id);
              setPendingPick(null);
            }}
            onReportBuilding={onReportBuilding}
            onBuildingsResolved={setResolved}
            callerZones={callerZones}
            focusTeam={focusTeam}
            onFocusTeam={(id) => setFocusTeam(id ? { id, key: Date.now() } : null)}
          />
          <UnitsPanel
            teams={state.teams}
            incidents={state.incidents}
            now={now}
            focusedId={focusTeam?.id ?? null}
            onFocus={(id) => setFocusTeam({ id, key: Date.now() })}
          />
          {!flood && (
            <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded bg-slate-900/90 px-3 py-2 text-sm">
              {elevationError ? `Elevation data failed to load: ${elevationError}` : "Loading elevation data…"}
            </div>
          )}
          {placing && (
            <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3 rounded bg-yellow-300 px-3 py-2 text-sm font-medium text-slate-900">
              Click the building for “{placing.reportedAddress}”
              <button onClick={() => setPlacingFor(null)} className="rounded bg-slate-900/15 px-2 py-0.5 text-xs">
                Cancel
              </button>
            </div>
          )}
          {toast && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded bg-red-600 px-3 py-2 text-sm shadow-lg">
              {toast}
            </div>
          )}
          <Legend />

          {(selected || pendingPick) && (
            <div className="absolute right-14 top-3 max-h-[calc(100%-1.5rem)] w-80 overflow-y-auto rounded-lg bg-slate-900/95 p-4 shadow-xl ring-1 ring-slate-700">
              {pendingPick ? (
                <NewReportForm
                  pick={pendingPick}
                  onCancel={() => setPendingPick(null)}
                  onSave={(action) => {
                    run(action);
                    setPendingPick(null);
                    setReportMode(false);
                  }}
                />
              ) : (
                selected && (
                  <IncidentDetail
                    key={selected.id}
                    incident={selected}
                    water={waterReport(selected)}
                    riverDepth={riverDepthAt(grid, riverFlood, selected)}
                    teams={state.teams}
                    options={teamOptions}
                    routeAlert={routeAlert}
                    onPreview={(teamId) => setPreview({ incidentId: selected.id, teamId })}
                    onReroute={(team) => {
                      const plan = planFor(team, selected, Date.now());
                      if (plan?.ok) run({ type: "reroute", teamId: team.id, plan: asTripPlan(plan) });
                      else setToast(plan ? `No safe route from here: ${plan.reason}.` : "Routes are still loading.");
                    }}
                    allIncidents={state.incidents}
                    priority={priorities.get(selected.linkedTo ?? selected.id) ?? null}
                    run={run}
                    onSelect={setSelectedId}
                    onPlace={() => {
                      setPlacingFor(selected.id);
                      setReportMode(false);
                    }}
                    onClose={() => setSelectedId(null)}
                  />
                )
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<ReturnType<typeof moverFor>, string> = {
  road_vehicle: "Vehicle",
  high_water_vehicle: "High-water truck",
  boat: "Boat",
  air: "Helicopter",
};

/** Every team at a glance; clicking one shows it on the map and follows it while it moves. */
function UnitsPanel({
  teams,
  incidents,
  now,
  focusedId,
  onFocus,
}: {
  teams: RescueTeam[];
  incidents: Incident[];
  now: number;
  focusedId: string | null;
  onFocus: (teamId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const available = teams.filter((t) => t.available).length;
  const status = (t: RescueTeam): { text: string; color: string } => {
    const incident = incidents.find((i) => i.id === t.currentAssignment);
    const where = incident ? ` · ${incident.reportedAddress}` : "";
    if (t.available) return { text: "Available", color: "#2563eb" };
    if (t.trip && now < t.trip.arriveAt) {
      const eta = Math.max(1, Math.ceil(((t.trip.arriveAt - now) * TRIP_SPEEDUP) / 60_000));
      return { text: `En route, ETA ${eta} min${where}`, color: "#f59e0b" };
    }
    if (incident?.status === "en_route") return { text: `On scene${where}`, color: "#16a34a" };
    return { text: `Assigned, not yet sent${where}`, color: "#64748b" };
  };
  return (
    <div className="absolute left-3 top-3 w-72 rounded bg-slate-900/90 text-xs ring-1 ring-slate-700">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 font-semibold uppercase tracking-wide text-slate-300"
      >
        <span>Units</span>
        <span className="font-normal normal-case text-slate-400">
          {available} of {teams.length} available {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <ul className="border-t border-slate-700">
          {teams.map((t) => {
            const s = status(t);
            return (
              <li key={t.id}>
                <button
                  onClick={() => onFocus(t.id)}
                  title="Show on map"
                  className={`flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-slate-800 ${
                    focusedId === t.id ? "bg-slate-800 ring-1 ring-inset ring-sky-400" : ""
                  }`}
                >
                  <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0">
                    <span className="font-semibold">{t.name}</span>{" "}
                    <span className="text-slate-400">{KIND_LABEL[moverFor(t.capabilities)]}</span>
                    <span className="block truncate text-slate-300">{s.text}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Legend() {
  const row = (color: string, label: string) => (
    <div className="flex items-center gap-2">
      <span className="inline-block h-3 w-3 rounded-sm" style={{ background: color }} />
      {label}
    </div>
  );
  return (
    <div className="absolute bottom-8 left-3 space-y-1 rounded bg-slate-900/90 p-3 text-xs ring-1 ring-slate-700">
      {row("#c62828", "Building with people awaiting rescue")}
      {row("#f59e0b", "Team assigned / en route")}
      {row("#4caf50", "Resolved")}
      {row("#2563eb", "Simulated rescue team")}
      {row("#f59e0b", `Team moving (simulated, ${TRIP_SPEEDUP}× speed)`)}
      <div className="flex items-center gap-2">
        <span className="inline-block h-1 w-3 rounded-sm" style={{ background: ROUTE_COLOR.road }} />
        road
        <span className="inline-block h-1 w-3 rounded-sm" style={{ background: ROUTE_COLOR.water }} />
        boat
        <span className="inline-block h-1 w-3 rounded-sm border-t-2 border-dashed border-slate-300" />
        on foot · routes avoid water too deep for each vehicle
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-12 rounded-sm bg-gradient-to-r from-[#9fd8f5] via-[#1f7fc4] to-[#174a8f]" />
        Water depth 0 → 6 m+
      </div>
      <p className="pt-1 text-[10px] text-slate-400">Flood extent is simulated from ground elevation.</p>
    </div>
  );
}

function IncidentDetail({
  incident,
  water,
  riverDepth,
  teams,
  options,
  routeAlert,
  onPreview,
  onReroute,
  allIncidents,
  priority,
  run,
  onSelect,
  onPlace,
  onClose,
}: {
  incident: Incident;
  water: ReturnType<typeof waterAtBuilding> | null;
  riverDepth: number | null;
  teams: RescueTeam[];
  options: TeamOption[];
  routeAlert: RouteAlert | null;
  onPreview: (teamId: string) => void;
  onReroute: (team: RescueTeam) => void;
  allIncidents: Incident[];
  priority: Priority | null;
  run: Run;
  onSelect: (id: string) => void;
  onPlace: () => void;
  onClose: () => void;
}) {
  const main = incident.linkedTo ? allIncidents.find((i) => i.id === incident.linkedTo) : null;
  const [teamId, setTeamId] = useState("");
  const available = options.filter((o) => o.team.available);
  const assigned = teams.find((t) => t.id === incident.assignedTeamId);
  const assignedPlan = options.find((o) => o.team.id === incident.assignedTeamId)?.plan ?? null;
  const st = STATUS_STYLE[incident.status];
  const onMap = incident.latitude != null && incident.longitude != null;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${st.cls}`}>
              {st.icon} {STATUS_LABEL[incident.status]}
            </span>
            {incident.callId && (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                  incident.callConnected ? "bg-emerald-400 text-slate-900" : "bg-slate-700 text-slate-300"
                }`}
              >
                {incident.callConnected ? "● Caller on the line" : "Call ended"}
              </span>
            )}
          </div>
          <h2 className="mt-1.5 font-semibold">{incident.reportedAddress}</h2>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>

      {priority && incident.status !== "resolved" && !main && (
        <PriorityPanel incident={incident} linked={allIncidents.filter((i) => i.linkedTo === incident.id)} priority={priority} run={run} />
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-400">People</dt>
        <dd>{incident.peopleCount ?? "Unknown"}</dd>
        <dt className="text-slate-400">Position</dt>
        <dd>{incident.reportedPosition ?? "Unknown"}</dd>
        <dt className="text-slate-400">Hazards</dt>
        <dd>
          {incident.hazards.length ? (
            <ul className="space-y-0.5">
              {incident.hazards.map((h) => (
                <li key={h.hazard}>
                  {h.hazard}
                  {h.evidence && <span className="text-slate-500"> — “{h.evidence}”</span>}
                </li>
              ))}
            </ul>
          ) : (
            "None reported"
          )}
        </dd>
        <dt className="text-slate-400">Summary</dt>
        <dd>{incident.summary || "—"}</dd>
        {incident.advisoryTags?.status === "ok" && incident.advisoryTags.tags.length > 0 && (
          <>
            <dt className="text-slate-400">Topic tags</dt>
            <dd>
              {incident.advisoryTags.tags.join(", ")}
              <span className="text-slate-500"> (advisory, ModernBERT; not verified facts)</span>
            </dd>
          </>
        )}
      </dl>

      {incident.factHistory && incident.factHistory.length > 0 && (
        <details className="rounded bg-slate-800/70 p-2 text-xs">
          <summary className="cursor-pointer text-slate-400">Changed by caller ({incident.factHistory.length})</summary>
          <ul className="mt-1.5 space-y-0.5 text-slate-300">
            {incident.factHistory.map((c, n) => (
              <li key={n}>
                {c.field}: was “{c.previous}”{c.evidence && <span className="text-slate-500"> — “{c.evidence}”</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {main ? (
        <div className="rounded bg-sky-500/10 p-2.5 text-xs ring-1 ring-sky-400/40">
          <p className="text-sky-200">
            Linked to <b>{main.reportedAddress}</b>. This caller hears that incident&apos;s progress.
          </p>
          {incident.linkNote && <p className="mt-0.5 text-sky-300/80">{incident.linkNote}</p>}
          <div className="mt-2 flex gap-2">
            <button onClick={() => onSelect(main.id)} className="rounded bg-sky-600 px-2.5 py-1 font-semibold">
              Open main report
            </button>
            <button onClick={() => run({ type: "unlinkReport", reportId: incident.id })} className="rounded bg-slate-700 px-2.5 py-1">
              Unlink
            </button>
          </div>
        </div>
      ) : (
        <SameLocation incident={incident} all={allIncidents} run={run} onSelect={onSelect} />
      )}

      {incident.callId && <CallerUpdates incident={incident} run={run} />}

      {incident.transcript && (
        <details className="rounded bg-slate-800/70 p-2 text-xs" open={incident.callConnected}>
          <summary className="cursor-pointer text-slate-400">Call transcript</summary>
          <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-slate-300">
            {incident.transcript}
          </pre>
        </details>
      )}

      {onMap && <WaterPanel water={water} />}
      {incident.waterReport && (
        <CallerWater report={incident.waterReport} riverDepth={riverDepth} verified={incident.locationVerified} />
      )}

      {main ? null : !onMap ? (
        <div className="rounded bg-yellow-300/10 p-2.5 ring-1 ring-yellow-400/50">
          <p className="text-xs text-yellow-200">
            No map location yet. Match the caller&apos;s description to a building.
          </p>
          <button onClick={onPlace} className="mt-2 rounded bg-yellow-300 px-2.5 py-1 text-xs font-semibold text-slate-900">
            Place on map
          </button>
        </div>
      ) : !incident.locationVerified ? (
        <div className="rounded bg-yellow-300/10 p-2.5 ring-1 ring-yellow-400/50">
          <p className="text-xs text-yellow-200">
            {incident.locationNote ? <b>{incident.locationNote}. </b> : null}
            Location is a candidate only. Check the highlighted building against the caller&apos;s description.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => run({ type: "verifyLocation", incidentId: incident.id })}
              className="rounded bg-yellow-300 px-2.5 py-1 text-xs font-semibold text-slate-900"
            >
              Confirm location
            </button>
            <button onClick={onPlace} className="rounded bg-slate-700 px-2.5 py-1 text-xs">
              Choose another building
            </button>
          </div>
        </div>
      ) : incident.status === "awaiting_assignment" ? (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">Teams by arrival time</p>
          <div className="space-y-1" role="radiogroup" aria-label="Choose team">
            {available.map(({ team, plan }, i) => (
              <button
                key={team.id}
                role="radio"
                aria-checked={teamId === team.id}
                onClick={() => {
                  setTeamId(team.id);
                  onPreview(team.id);
                }}
                className={`w-full rounded px-2 py-1.5 text-left text-xs ring-1 ${
                  teamId === team.id ? "bg-slate-800 ring-sky-400" : "bg-slate-800/50 ring-slate-700 hover:bg-slate-800"
                } ${plan && !plan.ok ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {team.name}
                    {i === 0 && plan?.ok && <span className="ml-1.5 text-[10px] text-emerald-400">FASTEST</span>}
                  </span>
                  <span className={plan?.ok ? "text-sky-300" : "text-red-400"}>
                    {plan == null ? "…" : plan.ok ? `${Math.max(1, Math.round(plan.realSeconds / 60))} min` : "can't reach"}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  {plan == null ? "Working out a route…" : plan.ok ? routeSummary(plan) : plan.reason}
                </div>
              </button>
            ))}
            {available.length === 0 && <p className="text-xs text-slate-500">No teams available.</p>}
          </div>
          <button
            disabled={!teamId}
            onClick={() => run({ type: "assignTeam", incidentId: incident.id, teamId })}
            className="w-full rounded bg-red-600 px-2.5 py-1.5 text-xs font-semibold disabled:opacity-40"
          >
            Approve assignment
          </button>
          {incident.callConnected && (
            <p className="text-[10px] text-slate-400">The caller will hear the confirmed assignment.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          {assigned && <p>Team: {assigned.name}</p>}
          {incident.status === "assigned" && assignedPlan && (
            <p className={assignedPlan.ok ? "text-slate-400" : "text-red-400"}>
              {assignedPlan.ok
                ? `Route: ${Math.max(1, Math.round(assignedPlan.realSeconds / 60))} min · ${routeSummary(assignedPlan)}`
                : `No safe route: ${assignedPlan.reason}. Unassign and send a boat or helicopter.`}
            </p>
          )}
          {routeAlert && (
            <div className="rounded bg-red-950/60 p-2 text-red-200 ring-1 ring-red-700">
              Water on {routeAlert.team.name}&apos;s remaining route is now {routeAlert.deepest.toFixed(1)} m, beyond a{" "}
              {routeAlert.label} ({routeAlert.limit} m).
              <button
                onClick={() => onReroute(routeAlert.team)}
                className="mt-1.5 block rounded bg-red-700 px-2 py-1 font-semibold text-white hover:bg-red-600"
              >
                Re-route from current position
              </button>
            </div>
          )}
          <div className="flex gap-2">
            {incident.status === "assigned" && (
              <button
                disabled={!assignedPlan?.ok}
                title={assignedPlan && !assignedPlan.ok ? assignedPlan.reason : undefined}
                onClick={() =>
                  assignedPlan?.ok &&
                  run({ type: "setStatus", incidentId: incident.id, status: "en_route", plan: asTripPlan(assignedPlan) })
                }
                className="rounded bg-slate-700 px-2.5 py-1 hover:bg-slate-600 disabled:opacity-40"
              >
                Send en route
              </button>
            )}
            {(incident.status === "assigned" || incident.status === "en_route") && (
              <button
                onClick={() => run({ type: "setStatus", incidentId: incident.id, status: "awaiting_assignment" })}
                className="rounded bg-slate-700 px-2.5 py-1 hover:bg-slate-600"
              >
                Unassign team
              </button>
            )}
            {incident.status !== "resolved" && (
              <button
                onClick={() => {
                  const notice = incident.callConnected ? " The caller will be told their rescue is complete." : "";
                  if (confirm(`Mark "${incident.reportedAddress}" as resolved? This can't be undone.${notice}`)) {
                    run({ type: "setStatus", incidentId: incident.id, status: "resolved" });
                  }
                }}
                className="rounded bg-green-700 px-2.5 py-1 hover:bg-green-600"
              >
                Mark resolved
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const LEG_WORDS = { road: "drive", water: "boat", foot: "on foot", air: "fly" } as const;

function distance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** e.g. "tow 2.3 km → boat 380 m → on foot 80 m · deepest water 0.3 of 0.6 m" */
function routeSummary(plan: RoutePlan) {
  const steps = [...new Set(plan.legs.map((l) => l.mode))].map((mode) => {
    const word = mode === "road" && plan.mover === "boat" ? "tow" : LEG_WORDS[mode];
    return `${word} ${distance(plan.metres[mode])}`;
  });
  const depth = plan.limit != null && plan.maxDepth > 0.05 ? ` · deepest water ${plan.maxDepth.toFixed(1)} of ${plan.limit} m` : "";
  return steps.join(" → ") + depth;
}

const TIER_STYLE: Record<PriorityTier, { label: string; cls: string }> = {
  critical: { label: "CRITICAL", cls: "bg-red-600 text-white" },
  high: { label: "HIGH", cls: "bg-orange-500 text-slate-950" },
  standard: { label: "STANDARD", cls: "bg-slate-600 text-slate-100" },
};

function TierPill({ priority }: { priority?: Priority }) {
  if (!priority) return null;
  const t = TIER_STYLE[priority.tier];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide ${t.cls}`}>
      {t.label}
      {priority.overrideReason != null && " ✎"}
    </span>
  );
}

/** Why the incident has its priority, with the caller's words, and a dispatcher override. */
function PriorityPanel({
  incident,
  linked,
  priority,
  run,
}: {
  incident: Incident;
  linked: Incident[];
  priority: Priority;
  run: Run;
}) {
  const [tier, setTier] = useState<PriorityTier>(priority.tier);
  const [reason, setReason] = useState("");
  const factors = [incident, ...linked].flatMap((i) =>
    (i.riskFactors ?? []).map((r) => ({ ...r, fromLinked: i.id !== incident.id })),
  );
  const seen = new Set<string>();
  const unique = factors.filter((f) => !seen.has(f.factor) && seen.add(f.factor));
  const modelReasons = priority.reasons.filter((r) => r.startsWith("water model"));

  return (
    <div className="rounded bg-slate-800/70 p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <TierPill priority={priority} />
        <span className="text-slate-400">
          {priority.overrideReason != null
            ? `Set by dispatcher (rules say ${priority.computedTier}): ${priority.overrideReason}`
            : "Priority from the rules below"}
        </span>
      </div>
      {unique.length || modelReasons.length ? (
        <ul className="mt-1.5 space-y-0.5">
          {unique.map((f) => (
            <li key={f.factor}>
              <b>{FACTOR_LABEL[f.factor]}</b>
              {f.evidence && <span className="text-slate-400"> — “{f.evidence}”</span>}
              {f.fromLinked && <span className="text-slate-500"> (linked report)</span>}
            </li>
          ))}
          {modelReasons.map((r) => (
            <li key={r} className="text-sky-300">{r}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-slate-500">No risk factors reported yet.</p>
      )}
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          run({ type: "setPriorityOverride", incidentId: incident.id, tier, reason });
          setReason("");
        }}
      >
        <select
          aria-label="Priority tier"
          value={tier}
          onChange={(e) => setTier(e.target.value as PriorityTier)}
          className="rounded bg-slate-900 px-1.5"
        >
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="standard">Standard</option>
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for changing"
          className="min-w-0 flex-1 rounded bg-slate-900 px-2 py-1"
        />
        <button type="submit" disabled={!reason.trim()} className="rounded bg-slate-600 px-2 disabled:opacity-40">
          Set
        </button>
      </form>
      {priority.overrideReason != null && (
        <button
          onClick={() => run({ type: "setPriorityOverride", incidentId: incident.id, tier: null, reason: "" })}
          className="mt-1.5 text-slate-400 underline"
        >
          Use the rules again
        </button>
      )}
    </div>
  );
}

const ROLE_LABEL = { trapped: "Trapped caller", witness: "Witness", unknown: "Caller" } as const;

function GroupBadges({ incident, all, linked }: { incident: Incident; all: Incident[]; linked: number }) {
  if (!isOpen(incident)) return linked ? <span className="text-[11px] text-slate-400">+{linked} linked</span> : null;
  const nearby = nearbyReports(incident, all);
  const likely = nearby.filter((n) => n.relation !== "separate_rescue").length;
  const { rescues } = buildingSummary(incident, nearby);
  return (
    <>
      {incident.callerRole === "witness" && (
        <span className="rounded bg-slate-600 px-1.5 py-0.5 text-[11px] font-semibold">Witness</span>
      )}
      {linked > 0 && (
        <span className="rounded bg-sky-500/80 px-1.5 py-0.5 text-[11px] font-semibold">+{linked} linked reports</span>
      )}
      {likely > 0 && (
        <span className="rounded bg-orange-400 px-1.5 py-0.5 text-[11px] font-semibold text-slate-900">
          {likely} possible duplicate{likely > 1 ? "s" : ""}
        </span>
      )}
      {rescues > 1 && (
        <span className="rounded bg-indigo-400 px-1.5 py-0.5 text-[11px] font-semibold text-slate-900">
          Same building · {rescues} rescues
        </span>
      )}
    </>
  );
}

const RELATION_LABEL: Record<NearbyReport["relation"], { text: string; cls: string }> = {
  likely_same: { text: "Likely same incident", cls: "text-orange-300" },
  possibly_same: { text: "Possibly same people", cls: "text-orange-200" },
  separate_rescue: { text: "Separate rescue, same building", cls: "text-indigo-300" },
};

/** Other reports at this building: link duplicates, keep separate rescues apart. */
function SameLocation({
  incident,
  all,
  run,
  onSelect,
}: {
  incident: Incident;
  all: Incident[];
  run: Run;
  onSelect: (id: string) => void;
}) {
  const linked = all.filter((i) => i.linkedTo === incident.id);
  const nearby = isOpen(incident) ? nearbyReports(incident, all) : [];
  if (!linked.length && !nearby.length) return null;

  const duplicates = nearby.filter((n) => n.relation === "likely_same");
  const summary = buildingSummary(incident, nearby);

  const link = (other: Incident) => {
    const [mainReport, report] = pickMain(incident, other);
    run({ type: "linkReports", mainId: mainReport.id, reportIds: [report.id] });
    onSelect(mainReport.id);
  };

  return (
    <div className="space-y-2 rounded bg-slate-800/70 p-2.5 text-xs">
      <h3 className="text-slate-400">At this building</h3>
      {summary.rescues > 1 && (
        <p className="text-indigo-200">
          {summary.rescues} separate rescues here · {summary.people} people reported in total
        </p>
      )}
      {nearby.map(({ incident: other, relation, reason }) => (
        <div key={other.id} className="rounded bg-slate-900/70 p-2">
          <p className={RELATION_LABEL[relation].cls}>
            <b>{RELATION_LABEL[relation].text}</b> · {ROLE_LABEL[other.callerRole ?? "unknown"]}
          </p>
          <button onClick={() => onSelect(other.id)} className="text-left text-slate-200 hover:underline">
            {other.reportedAddress} · {other.peopleCount ?? "?"} people · {other.reportedPosition ?? "position unknown"}
          </button>
          <p className="text-slate-500">{reason}</p>
          <div className="mt-1.5 flex gap-1.5">
            <button onClick={() => link(other)} className="rounded bg-orange-500 px-2 py-0.5 font-semibold text-slate-900">
              Same incident
            </button>
            <button
              onClick={() => run({ type: "markSeparate", incidentId: incident.id, otherId: other.id })}
              className="rounded bg-slate-700 px-2 py-0.5"
            >
              Separate rescue
            </button>
          </div>
        </div>
      ))}
      {duplicates.length > 1 && (
        <button
          onClick={() =>
            run({ type: "linkReports", mainId: incident.id, reportIds: duplicates.map((d) => d.incident.id) })
          }
          className="w-full rounded bg-orange-500 px-2 py-1 font-semibold text-slate-900"
        >
          Link all {duplicates.length} likely duplicates to this report
        </button>
      )}
      {linked.length > 0 && (
        <div>
          <p className="mb-1 text-sky-300">
            {linked.length} linked report{linked.length > 1 ? "s" : ""} (same people, hear this incident&apos;s updates).
            Unlink keeps them apart from now on.
          </p>
          <ul className="space-y-1">
            {linked.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-slate-300">
                  <span className="block truncate">
                    {ROLE_LABEL[r.callerRole ?? "unknown"]}: {r.reportedAddress}
                    {r.reportedPosition ? ` · ${r.reportedPosition}` : ""}
                  </span>
                  {r.linkNote && <span className="block truncate text-[10px] text-slate-500">{r.linkNote}</span>}
                </span>
                <button onClick={() => run({ type: "unlinkReport", reportId: r.id })} className="shrink-0 rounded bg-slate-700 px-2 py-0.5">
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const UPDATE_STATE_STYLE = {
  spoken: "text-emerald-300",
  waiting: "text-amber-300",
  replaced: "text-slate-500 line-through",
  "not delivered": "text-slate-500",
} as const;

/** What the voice agent has told (or will tell) the caller, plus a box to send a message. */
function CallerUpdates({ incident, run }: { incident: Incident; run: Run }) {
  const updates = useQuery(api.incidents.callerUpdates, {
    dispatcherToken: currentDispatcherToken(),
    incidentId: incident.id as Id<"incidents">,
  });
  const [message, setMessage] = useState("");

  return (
    <div className="rounded bg-slate-800/70 p-2.5 text-xs">
      <h3 className="mb-1.5 text-slate-400">What the caller has heard</h3>
      {updates?.length ? (
        <ul className="max-h-32 space-y-1 overflow-y-auto">
          {updates.map((u) => (
            <li key={u.id} className={UPDATE_STATE_STYLE[u.state]}>
              <span className="mr-1 text-[10px] uppercase tracking-wide opacity-80">{u.state}</span>
              {u.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-500">No updates yet.</p>
      )}
      {incident.callConnected && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim()) return;
            run({ type: "sendCallerMessage", incidentId: incident.id, message });
            setMessage("");
          }}
        >
          <input
            value={message}
            maxLength={300}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message for the caller, read out word for word"
            className="min-w-0 flex-1 rounded bg-slate-900 px-2 py-1.5"
          />
          <button type="submit" className="rounded bg-sky-600 px-2.5 py-1.5 font-semibold disabled:opacity-40" disabled={!message.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

function WaterPanel({ water }: { water: ReturnType<typeof waterAtBuilding> | null }) {
  if (!water) return <p className="text-xs text-slate-500">Water depth: loading…</p>;
  const { depth, buildingHeight, floorsUnderwater, totalFloors, submerged, dryClearance, groundElevation, waterSurface } =
    water;
  const pct = depth != null && buildingHeight ? Math.min(100, (depth / buildingHeight) * 100) : 0;

  return (
    <div className="rounded bg-slate-800/70 p-2.5">
      <div className="flex gap-3">
        {/* Building cross-section, to scale */}
        <div className="relative h-24 w-10 shrink-0 overflow-hidden rounded-sm bg-slate-500" title="Building cross-section">
          <div className="absolute inset-x-0 bottom-0 bg-sky-500/80" style={{ height: `${pct}%` }} />
        </div>
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          <dt className="text-slate-400">Water depth</dt>
          <dd className="font-semibold text-sky-300">{fmt(depth)}</dd>
          <dt className="text-slate-400">Building height</dt>
          <dd>{fmt(buildingHeight, 0)}</dd>
          <dt className="text-slate-400">Floors flooded</dt>
          <dd>
            {floorsUnderwater == null || totalFloors == null ? "unknown" : `${floorsUnderwater} of ~${totalFloors}`}
          </dd>
          <dt className="text-slate-400">Above water</dt>
          <dd>{submerged ? <b className="text-red-400">Fully submerged</b> : fmt(dryClearance)}</dd>
          <dt className="text-slate-400">Ground</dt>
          <dd>
            {fmt(groundElevation)} (water {waterSurface.toFixed(1)} m)
          </dd>
        </dl>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-slate-400">
        Estimated depth = local water surface − bare-earth ground elevation. The water surface comes from the river
        gauge, slopes with the river channel, and is corrected around callers who describe the water. Heights come
        from OpenStreetMap and may be estimated; floors assume ~3 m each.
      </p>
    </div>
  );
}

function riverDepthAt(grid: FloodGrid | null, riverFlood: FloodResult | null, incident: Incident) {
  if (!grid || !riverFlood || incident.latitude == null || incident.longitude == null) return null;
  return depthAt(grid, riverFlood, incident.longitude, incident.latitude);
}

/** Flags a gap this big between the caller and the river model. */
const DISAGREE_M = 0.5;

function CallerWater({
  report,
  riverDepth,
  verified,
}: {
  report: NonNullable<Incident["waterReport"]>;
  riverDepth: number | null;
  verified: boolean;
}) {
  const floor = report.floor ?? 0;
  // Depth above the street, to compare with the model.
  const callerDepth = report.meters + floor * FLOOR_HEIGHT_M;
  const gap = riverDepth == null ? null : callerDepth - riverDepth;
  return (
    <div className="rounded bg-slate-800/70 p-2.5 text-xs">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Caller vs. river model</div>
      <p>
        Caller: <b className="text-sky-300">{LEVEL_LABEL[report.level]}</b> (~{report.meters.toFixed(1)} m
        {floor > 0 ? ` on floor ${floor}, ~${callerDepth.toFixed(1)} m above the street` : ""})
        {report.evidence && <span className="text-slate-400"> — &ldquo;{report.evidence}&rdquo;</span>}
      </p>
      <p>
        River model alone: <b>{riverDepth == null ? "loading…" : `${riverDepth.toFixed(1)} m`}</b>
      </p>
      {gap != null &&
        (Math.abs(gap) > DISAGREE_M ? (
          <p className="mt-1 text-amber-300">
            They differ by {Math.abs(gap).toFixed(1)} m. The map uses the caller&apos;s report within ~
            {OBSERVATION_RADIUS_M} m{verified ? "" : " (location not yet confirmed)"}.
          </p>
        ) : (
          <p className="mt-1 text-slate-400">The caller and the model agree.</p>
        ))}
    </div>
  );
}

function NewReportForm({
  pick,
  onSave,
  onCancel,
}: {
  pick: BuildingPick;
  onSave: (action: Action) => void;
  onCancel: () => void;
}) {
  const [people, setPeople] = useState("");
  const [position, setPosition] = useState("");
  const [note, setNote] = useState("");

  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          type: "reportFromMap",
          latitude: pick.latitude,
          longitude: pick.longitude,
          peopleCount: people ? Number(people) : null,
          reportedPosition: position.trim() || null,
          reportedAddress: note.trim() || "Building marked on map",
        });
      }}
    >
      <h2 className="font-semibold">Mark people stuck in this building</h2>
      <p className="text-xs text-slate-400">Building height {pick.height != null ? `${pick.height} m` : "unknown"}</p>
      <input
        autoFocus
        type="number"
        min={1}
        placeholder="Number of people (leave blank if unknown)"
        value={people}
        onChange={(e) => setPeople(e.target.value)}
        className="w-full rounded bg-slate-800 px-2 py-1.5 text-xs"
      />
      <input
        placeholder="Position, e.g. roof, 2nd floor"
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        className="w-full rounded bg-slate-800 px-2 py-1.5 text-xs"
      />
      <input
        placeholder="Label / address"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="w-full rounded bg-slate-800 px-2 py-1.5 text-xs"
      />
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold">
          Add report
        </button>
        <button type="button" onClick={onCancel} className="rounded bg-slate-700 px-3 py-1.5 text-xs">
          Cancel
        </button>
      </div>
    </form>
  );
}
