"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadElevation, type ElevationGrid } from "@/lib/elevation";
import {
  buildRegionGrid,
  loadBuildings,
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
import { formatGaugeTime, gaugeFor, readingAt, readingIndex } from "@/lib/gauge";
import { REGIONS, type Bounds, type RegionId } from "../../convex/regions";
import {
  deepestAhead,
  loadRoads,
  moverFor,
  cachedRoute,
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
import { capitalize, capitalizeEach } from "@/lib/text";
import type { BuildingPick, ResolvedBuilding } from "./FloodMap";
import { etaMinutes, TRIP_SPEEDUP, vehiclePosition } from "../../convex/tripMath";
import { describeReport } from "../../convex/waterReports";
import { AssignmentPlanner } from "./AssignmentPlanner";
import { TierPill } from "./TierPill";
import { routeSummary } from "@/lib/routeText";

const FloodMap = dynamic(() => import("./FloodMap"), { ssr: false });

type Filter = "all" | "stuck" | "dispatched" | "resolved";
type Run = (action: Action) => void;
type Dock = "bottom" | "right";

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

const FILTER_LABEL: Record<Filter, string> = { all: "All", stuck: "Waiting", dispatched: "Dispatched", resolved: "Resolved" };

/** Case-insensitive match on what a dispatcher would type: address, position, summary or the short ID. */
function matchesQuery(incident: Incident, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [incident.reportedAddress, incident.reportedPosition, incident.summary, incident.id.slice(-8)]
    .some((field) => field?.toLowerCase().includes(q));
}

const icon = (path: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {path}
  </svg>
);
const SearchIcon = () => icon(<><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>);
const QueueIcon = () => icon(<path d="M3 4h10M3 8h10M3 12h6" />);
const SparkIcon = () => icon(<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4" />);
const PinIcon = () => icon(<><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z" /><circle cx="8" cy="6.5" r="1.5" /></>);
const BellIcon = () => icon(<><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" /><path d="M6.5 14a1.5 1.5 0 0 0 3 0" /></>);
const GearIcon = () => icon(<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>);
const FILTER_ICON: Record<Filter, React.ReactNode> = {
  all: null,
  stuck: icon(<><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>),
  dispatched: icon(<path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" />),
  resolved: icon(<path d="m3 8.5 3 3 7-7" />),
};

const STATUS_STYLE: Record<IncidentStatus, string> = {
  needs_review: "chip-neutral",
  awaiting_assignment: "chip-neutral",
  assigned: "chip-amber",
  en_route: "chip-amber",
  resolved: "chip-green",
};

const WATER_COMMIT_MS = 150;
// Each tick replays 30 minutes of the storm (two 15-minute gauge readings).
const REPLAY_TICK_MS = 3000;
const READINGS_PER_TICK = 2;
const TEAM_UPDATE_EVERY_TICKS = 3;
const CLOCK_MS = 2000;
/** Matches the sheet's exit animation in globals.css. */
const SHEET_EXIT_MS = 220;
const ACTIVITY_TOAST_MS = 4500;
/** Matches the section expand transition in globals.css. */
const SECTION_OPEN_MS = 300;
const SECTION_SCROLL_MARGIN = 10;

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
  // Area data, each kept with the region it was loaded for so a region switch never mixes them.
  const [elevationFor, setElevationFor] = useState<{ region: RegionId; data: ElevationGrid } | null>(null);
  const [buildingsFor, setBuildingsFor] = useState<{ region: RegionId; data: Float32Array } | null>(null);
  const [roadsFor, setRoadsFor] = useState<{ region: RegionId; data: RoadGraph } | null>(null);
  const region = REGIONS[state.region];
  const gauge = gaugeFor(region.id);
  const elevation = elevationFor?.region === region.id ? elevationFor.data : null;
  const buildings = buildingsFor?.region === region.id ? buildingsFor.data : null;
  const roads = roadsFor?.region === region.id ? roadsFor.data : null;
  const [elevationError, setElevationError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, ResolvedBuilding>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [waterDraft, setWaterDraft] = useState<number | null>(null);
  /** Team whose route is previewed for an incident. */
  const [preview, setPreview] = useState<{ incidentId: string; teamId: string } | null>(null);
  /** Assignment suggestions panel, and the route of the proposal being looked at. */
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerPreview, setPlannerPreview] = useState<RoutePlan | null>(null);
  /** Team the map shows and follows; `key` lets the same team be re-centred. */
  const [focusTeam, setFocusTeam] = useState<{ id: string; key: number } | null>(null);
  /** Clock for where moving teams are, refreshed while any team is travelling. */
  const [now, setNow] = useState(() => Date.now());
  const [dock, setDock] = useState<Dock>("bottom");
  const [closing, setClosing] = useState(false);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  /** Activity newer than this is flagged as unseen on the bell. */
  const [activitySeenAt, setActivitySeenAt] = useState(() => Date.now());
  /** Newest activity whose toast has already been shown or dismissed. */
  const [toastedActivityId, setToastedActivityId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const run: Run = useCallback((action) => {
    dispatch(action).catch((e) => setToast(errorMessage(e)));
  }, [setToast]);

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
    const area = REGIONS[region.id];
    loadElevation(area.bounds)
      .then((data) => setElevationFor({ region: area.id, data }))
      .catch((e: Error) => setElevationError(e.message));
    loadRoads(area.id)
      .then((data) => setRoadsFor({ region: area.id, data }))
      .catch((e: Error) => setToast(`Routing unavailable: ${e.message}`));
    // Without it boats still route, just straight across flooded buildings.
    loadBuildings(area)
      .then((data) => setBuildingsFor({ region: area.id, data }))
      .catch((e: Error) => console.warn(`Building footprints unavailable: ${e.message}`));
  }, [region.id]);

  const grid: FloodGrid | null = useMemo(
    () => (elevation ? { ...buildRegionGrid(elevation, REGIONS[region.id]), buildings: buildings ?? undefined } : null),
    [elevation, buildings, region.id],
  );
  // Callers' descriptions of the water, placed where they are.
  const observations: WaterObservation[] = useMemo(() => {
    if (!grid) return [];
    return state.incidents.flatMap((i) => {
      if (!i.waterReport || i.latitude == null || i.longitude == null) return [];
      const ground = elevation?.sample(i.longitude, i.latitude) ?? null;
      const at = observationAt(grid, i.waterReport, i.longitude, i.latitude, FLOOR_HEIGHT_M, ground);
      if (!at) return [];
      // Estimates pull the model less than a body reference or a measurement; "there's water" only adds.
      const weight = (i.locationVerified ? 1 : 0.5) * (i.waterReport.level === "estimated" ? 0.5 : 1);
      return [{ lon: i.longitude, lat: i.latitude, ...at, weight, raiseOnly: i.waterReport.level === "present" }];
    });
  }, [grid, elevation, state.incidents]);
  const callerZones = useMemo(
    () =>
      state.incidents.flatMap((i) =>
        i.waterReport && i.latitude != null && i.longitude != null && !i.linkedTo
          ? [{ lon: i.longitude, lat: i.latitude, label: `Caller: ${describeReport(i.waterReport)}` }]
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
  // What the planner's routes depend on locally besides the river level (which the planner
  // allows to move a little, see WATER_TOLERANCE_M): the road and elevation data.
  const routeContext = useMemo(() => JSON.stringify([roads != null, grid != null, buildings != null]), [roads, grid, buildings]);
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
      const [longitude, latitude] = team.trip ? vehiclePosition(team.trip, at) : [team.longitude, team.latitude];
      return cachedRoute(
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
      const g = gaugeFor(s.region);
      const current = readingIndex(g, s.waterObservedAt);
      if (current < g.readings.length - 1) {
        const next = readingAt(g, current < 0 ? 0 : current + READINGS_PER_TICK);
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
        if (!inFloodArea(region.bounds, pick.longitude, pick.latitude)) {
          setToast("That building is outside the flood model area, so the caller's water report won't show on the map.");
        }
        run({ type: "verifyLocation", incidentId: placingFor, latitude: pick.latitude, longitude: pick.longitude });
        setSelectedId(placingFor);
        setPlacingFor(null);
        return;
      }
      setPendingPick(pick);
      setSelectedId(null);
    },
    [placingFor, run, region.bounds, setToast],
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
    .filter((i) => FILTERS[filter](i.status) && matchesQuery(i, query))
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
  // The incident sheet slides over the map; closing plays the exit animation before clearing the selection.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeSheet = useCallback(() => {
    clearTimeout(closeTimer.current);
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setSelectedId(null);
      setPendingPick(null);
      setClosing(false);
    }, SHEET_EXIT_MS);
  }, []);
  const openIncident = useCallback((id: string | null) => {
    clearTimeout(closeTimer.current);
    setClosing(false);
    setSelectedId(id);
    setPendingPick(null);
  }, []);
  // Clicking the open incident again (in the list or on the map) closes it.
  const toggleSelected = useCallback(
    (id: string | null) => (id != null && id === selectedId && !closing ? closeSheet() : openIncident(id)),
    [selectedId, closing, closeSheet, openIncident],
  );
  // Opening the bell shows what's new; closing it marks everything seen.
  const closeActivity = useCallback(() => {
    setActivitySeenAt(Date.now());
    setActivityOpen(false);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== "Escape") return;
      if (transcriptId) setTranscriptId(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (activityOpen) closeActivity();
      else closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [transcriptId, settingsOpen, activityOpen, closeActivity, closeSheet]);
  const sheetRef = useRef<HTMLElement>(null);
  // The bottom sheet opens at its content's height, then keeps it: opening a section scrolls inside
  // the sheet instead of pushing it further over the map.
  const sheetKey = pendingPick ? "pick" : selectedId;
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.height = "";
    if (dock === "bottom") sheet.style.height = `${sheet.offsetHeight}px`;
  }, [sheetKey, dock]);
  // As a section expands, scroll just enough to keep it in view (never past its top).
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
    /** While `section` grows, scroll whatever holds it (its column, or the whole body) to keep it in view. */
    const reveal = (section: HTMLElement) => {
      const col = section.closest<HTMLElement>(".sheet-col");
      const scroller = col && getComputedStyle(col).overflowY !== "visible" ? col : section.closest<HTMLElement>(".sheet-body");
      if (!scroller) return;
      stop();
      observer = new ResizeObserver(() => {
        const box = section.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        const hidden = box.bottom - view.bottom + SECTION_SCROLL_MARGIN;
        if (hidden > 0) scroller.scrollTop += Math.min(hidden, box.top - view.top - SECTION_SCROLL_MARGIN);
      });
      observer.observe(section);
      timer = setTimeout(stop, SECTION_OPEN_MS * 3);
    };
    const onToggle = (e: Event) => {
      if (e.target instanceof HTMLDetailsElement && e.target.open) reveal(e.target);
    };
    // "Show more" lists grow their card the same way a section opens.
    const onClick = (e: Event) => {
      const card = e.target instanceof HTMLElement && e.target.closest(".show-more")?.closest<HTMLElement>(".sheet-card");
      if (card) reveal(card);
    };
    // `toggle` doesn't bubble, so listen while it's captured on the way down.
    sheet.addEventListener("toggle", onToggle, true);
    sheet.addEventListener("click", onClick);
    return () => {
      stop();
      sheet.removeEventListener("toggle", onToggle, true);
      sheet.removeEventListener("click", onClick);
    };
  }, [sheetKey]);
  const coveredBy = useCallback((): [number, number] => {
    const sheet = sheetRef.current;
    if (!sheet) return [0, 0];
    return dock === "bottom" ? [0, sheet.offsetHeight] : [sheet.offsetWidth, 0];
  }, [dock]);
  const unseenActivity = state.activity.filter((a) => a.at > activitySeenAt).length;
  // New activity pops a short notice under the bell while the list is closed.
  const newestActivity = state.activity[0];
  const activityToast =
    newestActivity && newestActivity.at > activitySeenAt && !activityOpen && newestActivity.id !== toastedActivityId
      ? newestActivity
      : null;
  const activityToastId = activityToast?.id ?? null;
  useEffect(() => {
    if (!activityToastId) return;
    const t = setTimeout(() => setToastedActivityId(activityToastId), ACTIVITY_TOAST_MS);
    return () => clearTimeout(t);
  }, [activityToastId]);
  const transcriptIncident = state.incidents.find((i) => i.id === transcriptId) ?? null;

  return (
    <div className="dispatcher flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="console-header">
        <Link href="/" className="brand">Lifeline</Link>
        <span className="console-region">
          <PinIcon />
          {region.name}
        </span>
        <div className="console-metrics">
          <span><i className="live-dot" /> On call <b>{state.incidents.filter((i) => i.callConnected).length}</b></span>
          <span>Needs review <b>{mainIncidents.filter((i) => i.status === "needs_review").length}</b></span>
          <span>Active rescues <b>{mainIncidents.filter((i) => DISPATCHED_STATUSES.includes(i.status)).length}</b></span>
          <span>Teams free <b>{state.teams.filter((t) => t.available).length}</b></span>
          <span title={`${gauge.agency} ${gauge.site} ${gauge.name}`}>{gauge.label} <b>{gauge.display(waterLevel)}</b></span>
        </div>
        <button
          onClick={() => {
            if (activityOpen) closeActivity();
            else setActivityOpen(true);
            setSettingsOpen(false);
          }}
          aria-expanded={activityOpen}
          aria-label={`Activity${unseenActivity ? `, ${unseenActivity} new` : ""}`}
          title="Activity"
          className={`icon-button relative ${activityOpen ? "icon-button-on" : ""}`}
        >
          <BellIcon />
          {unseenActivity > 0 && <span className="icon-badge">{unseenActivity > 9 ? "9+" : unseenActivity}</span>}
        </button>
        {activityToast && (
          <button
            key={activityToast.id}
            className="activity-toast"
            onClick={() => setToastedActivityId(activityToast.id)}
            title="Dismiss"
          >
            <BellIcon />
            <span>{activityToast.message}</span>
          </button>
        )}
        {activityOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={closeActivity} aria-hidden />
            <section className="settings-popover activity-popover" aria-label="Activity">
              <h2>Activity</h2>
              <ul>
                {state.activity.slice(0, 40).map((a) => (
                  <li key={a.id} className={a.at > activitySeenAt ? "is-new" : undefined}>
                    <span>{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <p>{a.message}</p>
                  </li>
                ))}
                {!state.activity.length && <li><p className="text-slate-500">Nothing yet.</p></li>}
              </ul>
            </section>
          </>
        )}
        <button
          onClick={() => {
            setSettingsOpen((v) => !v);
            if (activityOpen) closeActivity();
          }}
          aria-expanded={settingsOpen}
          aria-label="Simulation settings"
          title="Simulation settings"
          className={`icon-button ${settingsOpen || liveFeed ? "icon-button-on" : ""}`}
        >
          <GearIcon />
        </button>
        {settingsOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} aria-hidden />
            <section className="settings-popover" aria-label="Simulation settings">
              <h2>Simulation</h2>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-400" htmlFor="exercise-area">
                Area
              </label>
              <select
                id="exercise-area"
                value={region.id}
                onChange={(e) => {
                  const next = e.target.value as RegionId;
                  if (!confirm(`Move the exercise to ${REGIONS[next].name}? This clears every incident for everyone.`)) return;
                  setLiveFeed(false);
                  setSelectedId(null);
                  setPendingPick(null);
                  setPlacingFor(null);
                  setPlannerOpen(false);
                  run({ type: "reset", region: next });
                }}
                className="area-select"
              >
                {Object.values(REGIONS).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
                {gauge.label} level at the {gauge.name}
              </label>
              <input
                type="range"
                min={region.water.min}
                max={region.water.max}
                step={0.05}
                value={waterLevel}
                onChange={(e) => setWaterDraft(Number(e.target.value))}
                className="w-full accent-sky-400"
              />
              <p className="text-xs text-slate-400">
                {region.flood.kind === "river" ? (
                  <>
                    {gauge.display(waterLevel, 2)} gauge height ({waterLevel.toFixed(2)} m above sea level)
                    {depthOverChannel != null && <> · {depthOverChannel.toFixed(1)} m above the river channel</>}
                  </>
                ) : (
                  <>{waterLevel.toFixed(2)} m above sea level (NAVD88)</>
                )}
              </p>
              <p className="text-[10px] leading-snug text-slate-500">
                {observedAt != null
                  ? `Recorded by ${gauge.agency} gauge ${gauge.site} at ${formatGaugeTime(observedAt)}: ${gauge.event}.`
                  : `Set by hand. Replay uses ${gauge.agency} gauge ${gauge.site} readings: ${gauge.event}.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setLiveFeed((v) => !v)}
                  className={`soft-button ${liveFeed ? "soft-button-on" : ""}`}
                >
                  {liveFeed ? `● Replaying ${gauge.replayName}` : `Replay ${gauge.replayName}`}
                </button>
                <button
                  onClick={() => {
                    // Close the popover so the dispatcher can click a building straight away.
                    if (!reportMode) setSettingsOpen(false);
                    setReportMode((v) => !v);
                    setPlacingFor(null);
                    setPendingPick(null);
                  }}
                  className={`soft-button ${reportMode && !placingFor ? "soft-button-alert" : ""}`}
                >
                  {reportMode && !placingFor ? "Click a building… (cancel)" : "+ Mark stuck people"}
                </button>
                <button
                  onClick={() => {
                    if (!confirm("Clear every incident for everyone and send all teams back to base?")) return;
                    setLiveFeed(false);
                    setSelectedId(null);
                    setPendingPick(null);
                    setPlacingFor(null);
                    run({ type: "reset" });
                  }}
                  className="soft-button"
                >
                  Reset
                </button>
              </div>
            </section>
          </>
        )}
      </header>

      <div className="console-body flex min-h-0 flex-1">
        {/* Left: controls, queue, activity */}
        <aside className="incident-sidebar panel flex shrink-0 flex-col">
          <div className="queue-heading">
            <h2>Incidents</h2>
            <span className="count-badge">
              <QueueIcon /> {mainIncidents.filter((i) => ACTIVE_STATUSES.includes(i.status)).length} waiting
            </span>
            <button
              onClick={() => {
                setPlannerOpen(true);
                setSelectedId(null);
                setPendingPick(null);
              }}
              title="Suggest assignments"
              className="suggest-button"
            >
              <SparkIcon /> Suggest
            </button>
          </div>

          <label className="queue-search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search address, people, summary…"
              aria-label="Search incidents"
            />
            <kbd>⌘K</kbd>
          </label>
          <section className="queue-filters flex gap-1.5">
            {(Object.keys(FILTERS) as Filter[]).map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {FILTER_ICON[f]}
                {FILTER_LABEL[f]}
              </button>
            ))}
          </section>

          <ul className="incident-queue min-h-0 flex-1 overflow-y-auto">
            {incidents.map((i) => {
              const p = priorities.get(i.id);
              return (
                <li key={i.id}>
                  <button onClick={() => toggleSelected(i.id)} aria-pressed={i.id === selectedId} className="incident-card">
                    <div className="flex items-start justify-between gap-3">
                      <p className="incident-card-title">{capitalize(i.reportedAddress)}</p>
                      {i.status !== "resolved" && <TierPill priority={p} />}
                    </div>
                    {i.status !== "resolved" && !!p?.reasons.length && (
                      <p className="incident-card-reasons">{capitalizeEach(p.reasons.slice(0, 3)).join(" · ")}</p>
                    )}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className={`chip ${STATUS_STYLE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                      {i.latitude == null ? (
                        <span className="chip chip-amber">Not on map</span>
                      ) : (
                        !i.locationVerified && (
                          <span className="chip chip-amber">
                            {i.locationNote?.startsWith("Map search") ? "Auto-located · confirm" : "Location unverified"}
                          </span>
                        )
                      )}
                      {i.callConnected && <span className="chip chip-green"><i className="live-dot" /> On call</span>}
                      <GroupBadges incident={i} all={state.incidents} linked={linkedCount(i.id)} />
                    </div>
                  </button>
                </li>
              );
            })}
            {!incidents.length && (
              <li className="px-2 py-4 text-sm text-slate-500">
                {query ? `No incidents match “${query}”.` : "No incidents match this filter."}
              </li>
            )}
          </ul>

        </aside>

        {/* Map */}
        <main className="map-workspace relative min-w-0 flex-1" aria-label="Flood response map">
          <div className="map-canvas panel">
          <FloodMap
            state={mapState}
            flood={flood}
            preview={plannerOpen && plannerPreview ? { path: plannerPreview.path, legs: plannerPreview.legs } : previewPlan}
            selectedId={selectedId}
            reportMode={reportMode || placingFor != null}
            onSelect={toggleSelected}
            coveredBy={coveredBy}
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
            <div className="map-overlay absolute left-1/2 top-4 -translate-x-1/2 px-3 py-2 text-sm">
              {elevationError ? `Elevation data failed to load: ${elevationError}` : "Loading elevation data…"}
            </div>
          )}
          {placing && (
            <div className="map-overlay absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3 px-3 py-2 text-sm font-medium text-amber-200">
              Click the building for “{placing.reportedAddress}”
              <button onClick={() => setPlacingFor(null)} className="soft-button">
                Cancel
              </button>
            </div>
          )}
          {toast && (
            <button
              onClick={() => setToast(null)}
              title="Dismiss"
              className="absolute bottom-8 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-red-600 px-3 py-2 text-left text-sm shadow-lg"
            >
              {toast}
            </button>
          )}
          <Legend />

          {plannerOpen && (
            // Kept mounted while an incident is open, so the plan under review survives.
            <section
              aria-label="Suggested assignments"
              className={`planner-sheet ${selected || pendingPick ? "hidden" : ""}`}
            >
              <AssignmentPlanner
                state={state}
                priorities={priorities}
                routeFor={(team, incident) => planFor(team, incident, Date.now())}
                routeContext={routeContext}
                notReady={
                  waterDraft != null
                    ? "Wait for the river level change to save, then suggest."
                    : pendingPick || placingFor
                      ? "Finish or cancel the location you're placing on the map, then suggest."
                      : null
                }
                onPreview={setPlannerPreview}
                onSelectIncident={openIncident}
                onDone={setToast}
                onApproved={(approved) => {
                  // Approving a plan dispatches it: each team sets off on the route the plan was approved with.
                  for (const p of approved) {
                    run({ type: "setStatus", incidentId: p.incident.id, status: "en_route", plan: asTripPlan(p.route) });
                  }
                }}
                onClose={() => {
                  setPlannerOpen(false);
                  setPlannerPreview(null);
                }}
              />
            </section>
          )}
          {(selected || pendingPick) && (
            <section
              ref={sheetRef}
              aria-label="Incident details"
              data-dock={dock}
              className={`incident-sheet ${closing ? "is-closing" : ""}`}
            >
              {plannerOpen && (
                <button onClick={closeSheet} className="sheet-back">
                  ← Back to suggested assignments
                </button>
              )}
              {pendingPick ? (
                <NewReportForm
                  pick={pendingPick}
                  onCancel={closeSheet}
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
                    area={region.bounds}
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
                    onSelect={openIncident}
                    onPlace={() => {
                      setPlacingFor(selected.id);
                      setReportMode(false);
                    }}
                    dock={dock}
                    onDock={setDock}
                    onTranscript={() => setTranscriptId(selected.id)}
                    onClose={closeSheet}
                  />
                )
              )}
            </section>
          )}
          </div>
        </main>
      </div>
      {transcriptIncident && <TranscriptModal incident={transcriptIncident} onClose={() => setTranscriptId(null)} />}
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
  // `rank` orders the list: available first, then en route, on scene, and assigned but not sent.
  const status = (t: RescueTeam): { text: string; color: string; rank: number } => {
    const incident = incidents.find((i) => i.id === t.currentAssignment);
    const where = incident ? ` · ${incident.reportedAddress}` : "";
    if (t.available) return { text: "Available", color: "#2563eb", rank: 0 };
    if (t.trip && now < t.trip.arriveAt) {
      return { text: `En route, ETA ${etaMinutes(t.trip, now)} min${where}`, color: "#f59e0b", rank: 1 };
    }
    if (incident?.status === "en_route") return { text: `On scene${where}`, color: "#16a34a", rank: 2 };
    return { text: `Assigned, not yet sent${where}`, color: "#64748b", rank: 3 };
  };
  const rows = teams.map((t) => ({ team: t, status: status(t) })).sort((a, b) => a.status.rank - b.status.rank);
  return (
    <div className="map-overlay absolute left-3 top-3 w-80 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3.5 py-2.5 font-semibold text-slate-200"
      >
        <span>Units</span>
        <span className="font-normal normal-case text-slate-400">
          {available} of {teams.length} available {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        // About six rows tall, then it scrolls.
        <ul className="max-h-[19.5rem] overflow-y-auto overscroll-contain border-t border-white/5 p-1">
          {rows.map(({ team: t, status: s }) => {
            return (
              <li key={t.id}>
                <button
                  onClick={() => onFocus(t.id)}
                  title="Show on map"
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/5 ${
                    focusedId === t.id ? "bg-white/8 ring-1 ring-inset ring-white/20" : ""
                  }`}
                >
                  <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0">
                    <span className="font-semibold">{t.name}</span>{" "}
                    <span className="text-slate-400">{KIND_LABEL[moverFor(t.capabilities)]}</span>
                    <span className="block truncate text-slate-400">{s.text}</span>
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
    <details className="map-overlay map-legend absolute bottom-16 left-3 text-xs text-slate-300">
      <summary>Map legend</summary>
      <div className="space-y-1 px-3 pb-3">
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
    </details>
  );
}

/** Fastest reachable teams listed before "Show more", and hazards before "+N more". */
const TEAMS_SHOWN = 3;
const HAZARDS_SHOWN = 2;

function IncidentDetail({
  area,
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
  dock,
  onDock,
  onTranscript,
  onClose,
}: {
  /** The exercise area, which the flood model covers. */
  area: Bounds;
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
  dock: Dock;
  onDock: (dock: Dock) => void;
  onTranscript: () => void;
  onClose: () => void;
}) {
  const main = incident.linkedTo ? allIncidents.find((i) => i.id === incident.linkedTo) : null;
  const [teamId, setTeamId] = useState("");
  // Lists shown in full, as `${incident id}:${list}`, so switching incidents starts collapsed again.
  const [expanded, setExpanded] = useState<string[]>([]);
  const isOpen = (list: string) => expanded.includes(`${incident.id}:${list}`);
  const toggle = (list: string) =>
    setExpanded((e) => (isOpen(list) ? e.filter((k) => k !== `${incident.id}:${list}`) : [...e, `${incident.id}:${list}`]));
  const available = options.filter((o) => o.team.available);
  // The fastest few teams that can get there; the rest, and every team that can't, are folded away.
  const reachable = available.filter((o) => o.plan?.ok !== false);
  const unreachable = available.filter((o) => o.plan?.ok === false);
  const shownTeams = isOpen("teams") ? reachable : reachable.slice(0, TEAMS_SHOWN);
  const assigned = teams.find((t) => t.id === incident.assignedTeamId);
  const assignedPlan = options.find((o) => o.team.id === incident.assignedTeamId)?.plan ?? null;
  const onMap = incident.latitude != null && incident.longitude != null;
  const people = incident.peopleCount == null ? "People unknown" : `${incident.peopleCount} ${incident.peopleCount === 1 ? "person" : "people"}`;
  const describe = (factors: string[]) =>
    (incident.riskFactors ?? [])
      .filter((r) => factors.includes(r.factor))
      .map((r) => r.evidence || FACTOR_LABEL[r.factor])
      .join(" · ");
  // Only facts the caller actually gave are listed; the rest are named once underneath.
  const facts: { label: string; value: React.ReactNode }[] = [];
  const missing: string[] = [];
  // `quiet` facts are shown when given but not listed as missing.
  const fact = (label: string, value: React.ReactNode, quiet = false) =>
    value ? facts.push({ label, value }) : quiet || missing.push(label.toLowerCase());
  fact(
    "Location",
    <span className="fact-location">
      {capitalize(incident.reportedAddress)}
      <span className={`chip ${!onMap ? "chip-amber" : incident.locationVerified ? "chip-green" : "chip-amber"}`}>
        {!onMap ? "Not on map" : incident.locationVerified ? "Verified" : "Unverified"}
      </span>
    </span>,
  );
  fact("Position", capitalize(incident.reportedPosition));
  fact("Medical", capitalize(describe(["serious_injury", "medical_need"])));
  fact("Mobility", capitalize(describe(["limited_mobility"])));
  fact("Higher ground", capitalize(describe(["no_higher_ground"])), true);
  // Water risk factors when the caller gave them, otherwise the water reading the map uses.
  const report = incident.waterReport;
  fact(
    "Water",
    capitalize(describe(["water_chest_or_higher", "water_rising_fast", "in_moving_water"])) ||
      (report && (
        <>
          {capitalize(describeReport(report))}
          {report.evidence && <q className="fact-evidence">{report.evidence}</q>}
        </>
      )),
  );
  fact(
    "Hazards",
    incident.hazards.length > 0 && (
      <>
        <ul className="space-y-2">
          {(isOpen("hazards") ? incident.hazards : incident.hazards.slice(0, HAZARDS_SHOWN)).map((h) => (
            <li key={h.hazard}>
              {capitalize(h.hazard)}
              {h.evidence && <q className="fact-evidence">{h.evidence}</q>}
            </li>
          ))}
        </ul>
        {incident.hazards.length > HAZARDS_SHOWN && (
          <button onClick={() => toggle("hazards")} className="show-more">
            {isOpen("hazards") ? "Show fewer" : `+${incident.hazards.length - HAZARDS_SHOWN} more`}
          </button>
        )}
      </>
    ),
  );
  const nextStep = main
    ? "Linked report"
    : !onMap
      ? "Place on map"
      : !incident.locationVerified
        ? "Verify location"
        : incident.status === "awaiting_assignment"
          ? "Send a team"
          : incident.status === "resolved"
            ? "Resolved"
            : assigned
              ? "Assigned team"
              : "Actions";

  return (
    <div className="sheet-content">
      <header className="sheet-header">
        <div className="min-w-0">
          <h2 className="sheet-title" title={capitalize(incident.reportedAddress)}>
            {capitalize(incident.reportedAddress)}
          </h2>
          <p className="sheet-subtitle">
            {people}
            {incident.reportedPosition ? ` · ${capitalize(incident.reportedPosition)}` : ""}
            <span className="detail-id" title={incident.id}>{incident.id.slice(-8).toUpperCase()}</span>
          </p>
        </div>
        <div className="sheet-tags">
          {incident.status !== "resolved" && <TierPill priority={priority ?? undefined} />}
          <span className={`chip ${STATUS_STYLE[incident.status]}`}>{STATUS_LABEL[incident.status]}</span>
          {incident.callId && (
            <span className={`chip ${incident.callConnected ? "chip-green" : "chip-neutral"}`}>
              {incident.callConnected && <i className="live-dot" />}
              {incident.callConnected ? "Caller on the line" : "Call ended"}
            </span>
          )}
        </div>
        <div className="sheet-tools">
          <button onClick={onTranscript} className="soft-button">
            <TranscriptIcon /> Transcript
          </button>
          <button
            onClick={() => onDock(dock === "bottom" ? "right" : "bottom")}
            className="close-button"
            aria-label={dock === "bottom" ? "Dock to the right" : "Dock to the bottom"}
            title={dock === "bottom" ? "Dock to the right" : "Dock to the bottom"}
          >
            {dock === "bottom" ? "⇥" : "⤓"}
          </button>
          <button onClick={onClose} className="close-button" aria-label="Close incident details" title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      <div className="sheet-body">
        <div className="sheet-col">
          <section className="sheet-card">
            <dl className="sheet-stats">
              <div><dt>People</dt><dd>{incident.peopleCount ?? "Unknown"}</dd></div>
              <div><dt>Water depth</dt><dd>{water?.depth == null ? "Unknown" : `${water.depth.toFixed(1)} m`}</dd></div>
              <div>
                <dt>Location</dt>
                <dd className={incident.locationVerified ? "text-emerald-300" : "text-amber-200"}>
                  {!onMap ? "Not on map" : incident.locationVerified ? "Verified" : "Unverified"}
                </dd>
              </div>
            </dl>
            <h3>AI summary</h3>
            <p className="sheet-summary">{incident.summary || "Waiting for a caller report. No summary yet."}</p>
          </section>
          {priority && incident.status !== "resolved" && !main && (
            <details>
              <summary>Priority assessment & override</summary>
              <PriorityPanel incident={incident} linked={allIncidents.filter((i) => i.linkedTo === incident.id)} priority={priority} run={run} />
            </details>
          )}
          {incident.waterReport && (
            <details>
              <summary>Caller vs. river model</summary>
              <CallerWater
                report={incident.waterReport}
                riverDepth={riverDepth}
                verified={incident.locationVerified}
                outsideModel={onMap && !inFloodArea(area, incident.longitude!, incident.latitude!)}
              />
            </details>
          )}
          {onMap && (
            <details>
              <summary>Flood model details</summary>
              <WaterPanel water={water} />
            </details>
          )}
        </div>
        <div className="sheet-col">
          <section className="sheet-card">
            <h3>Extracted facts</h3>
            <dl className="fact-table">
              {facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {missing.length > 0 && <p className="fact-missing">Not reported yet: {missing.join(", ")}</p>}
            {incident.advisoryTags?.status === "ok" && incident.advisoryTags.tags.length > 0 && (
              <p className="fact-missing">Advisory topic tags: {incident.advisoryTags.tags.join(", ")} (not verified facts)</p>
            )}
          </section>
          {!main && <SameLocation incident={incident} all={allIncidents} run={run} onSelect={onSelect} />}
          {incident.factHistory && incident.factHistory.length > 0 && <FactHistory changes={incident.factHistory} />}
        </div>
        <div className="sheet-col sheet-actions-col">
          <section className="sheet-card sheet-actions">
            <h3>{nextStep}</h3>
            {main ? (
              <div className="space-y-3 text-sm">
                <p className="text-slate-300">
                  Linked to <b>{main.reportedAddress}</b>. This caller hears that incident&apos;s progress.
                </p>
                {incident.linkNote && <p className="text-xs text-slate-400">{incident.linkNote}</p>}
                <div className="flex gap-2">
                  <button onClick={() => onSelect(main.id)} className="primary-button">Open main report</button>
                  <button onClick={() => run({ type: "unlinkReport", reportId: incident.id })} className="soft-button">
                    Unlink
                  </button>
                </div>
              </div>
            ) : !onMap ? (
              <div className="space-y-3">
                <p className="action-note">No map location yet. Match the caller&apos;s description to a building.</p>
                <button onClick={onPlace} className="primary-button w-full">Place on map</button>
              </div>
            ) : !incident.locationVerified ? (
              <div className="space-y-3">
                <p className="action-note">
                  {incident.locationNote ? <b>{incident.locationNote}. </b> : null}
                  The location is a candidate only. Check the highlighted building against the caller&apos;s description.
                </p>
                <button onClick={() => run({ type: "verifyLocation", incidentId: incident.id })} className="primary-button w-full">
                  Confirm location
                </button>
                <button onClick={onPlace} className="soft-button w-full">Choose another building</button>
              </div>
            ) : incident.status === "awaiting_assignment" ? (
              <div className="space-y-2">
                <div className="space-y-1.5" role="radiogroup" aria-label="Choose team">
                  {shownTeams.map(({ team, plan }, i) => (
                    <button
                      key={team.id}
                      role="radio"
                      aria-checked={teamId === team.id}
                      onClick={() => {
                        setTeamId(team.id);
                        onPreview(team.id);
                      }}
                      className={`team-option ${plan && !plan.ok ? "opacity-60" : ""}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {team.name}
                          {i === 0 && plan?.ok && <span className="chip chip-green ml-2">Fastest</span>}
                        </span>
                        <span className={`font-mono text-xs ${plan?.ok ? "text-sky-300" : "text-red-300"}`}>
                          {plan == null ? "…" : plan.ok ? `${Math.max(1, Math.round(plan.realSeconds / 60))} min` : "can't reach"}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-400">
                        {plan == null ? "Working out a route…" : plan.ok ? routeSummary(plan) : plan.reason}
                      </span>
                    </button>
                  ))}
                  {reachable.length > TEAMS_SHOWN && (
                    <button onClick={() => toggle("teams")} className="show-more">
                      {isOpen("teams") ? "Show fewer" : `Show ${reachable.length - TEAMS_SHOWN} more`}
                    </button>
                  )}
                  {available.length === 0 && <p className="action-note">No teams available.</p>}
                  {available.length > 0 && reachable.length === 0 && (
                    <p className="action-note">No available team can reach it under the simulated flood.</p>
                  )}
                  {unreachable.length > 0 && (
                    <div className="unreachable">
                      <button onClick={() => toggle("unreachable")} aria-expanded={isOpen("unreachable")} className="show-more">
                        {unreachable.length} {unreachable.length === 1 ? "team can't" : "teams can't"} reach it {isOpen("unreachable") ? "▾" : "▸"}
                      </button>
                      {isOpen("unreachable") && (
                        <ul>
                          {unreachable.map(({ team, plan }) => (
                            <li key={team.id}>
                              <b>{team.name}</b> {plan && !plan.ok ? plan.reason : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                <button
                  disabled={!teamId}
                  onClick={() => run({ type: "assignTeam", incidentId: incident.id, teamId })}
                  className="primary-button w-full"
                >
                  Approve assignment
                </button>
                {incident.callConnected && <p className="text-[11px] text-slate-500">The caller will hear the confirmed assignment.</p>}
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                {assigned && (
                  <div>
                    <p className="font-medium">{assigned.name}</p>
                    <p className="text-xs capitalize text-slate-400">{assigned.capabilities.join(" · ").replaceAll("_", " ")}</p>
                  </div>
                )}
                {incident.status === "assigned" && assignedPlan && (
                  <p className={`text-xs ${assignedPlan.ok ? "text-slate-400" : "text-red-300"}`}>
                    {assignedPlan.ok
                      ? `Route: ${Math.max(1, Math.round(assignedPlan.realSeconds / 60))} min · ${routeSummary(assignedPlan)}`
                      : `No safe route: ${assignedPlan.reason}. Unassign and send a boat or helicopter.`}
                  </p>
                )}
                {routeAlert && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                    Water on {routeAlert.team.name}&apos;s remaining route is now {routeAlert.deepest.toFixed(1)} m, beyond a{" "}
                    {routeAlert.label} ({routeAlert.limit} m).
                    <button onClick={() => onReroute(routeAlert.team)} className="soft-button soft-button-alert mt-2 w-full">
                      Re-route from current position
                    </button>
                  </div>
                )}
                {incident.status === "assigned" && (
                  <button
                    disabled={!assignedPlan?.ok}
                    title={assignedPlan && !assignedPlan.ok ? assignedPlan.reason : undefined}
                    onClick={() =>
                      assignedPlan?.ok &&
                      run({ type: "setStatus", incidentId: incident.id, status: "en_route", plan: asTripPlan(assignedPlan) })
                    }
                    className="primary-button w-full"
                  >
                    Send en route
                  </button>
                )}
                <div className="flex gap-2">
                  {(incident.status === "assigned" || incident.status === "en_route") && (
                    <button
                      onClick={() => run({ type: "setStatus", incidentId: incident.id, status: "awaiting_assignment" })}
                      className="soft-button flex-1"
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
                      className="soft-button soft-button-on flex-1"
                    >
                      Mark resolved
                    </button>
                  )}
                </div>
                {incident.status === "resolved" && <p className="action-note">This rescue is complete.</p>}
              </div>
            )}
          </section>
          {incident.callId && (
            <details>
              <summary>Caller updates & messages</summary>
              <CallerUpdates incident={incident} run={run} />
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}

type Turn = { speaker: "Caller" | "AI" | null; text: string };

/** Split the saved speaker-prefixed text into turns without inventing turns or dropping lines. */
function parseTranscript(transcript: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of transcript.split("\n")) {
    const match = /^(caller|agent|ai):\s*(.*)$/i.exec(line);
    if (match) {
      turns.push({ speaker: match[1].toLowerCase() === "caller" ? "Caller" : "AI", text: match[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += `\n${line}`;
    } else {
      turns.push({ speaker: null, text: line });
    }
  }
  return turns;
}

function TranscriptModal({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const turns = incident.transcript?.trim() ? parseTranscript(incident.transcript) : [];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Call transcript"
        className="transcript-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="transcript-modal-header">
          <div className="min-w-0">
            <p className="transcript-eyebrow">Call transcript</p>
            <h2>{capitalize(incident.reportedAddress)}</h2>
            <p className="transcript-meta">
              {incident.callId ? (incident.callConnected ? "Caller on the line · updating live" : "Call ended") : "No phone call"}
              {turns.length > 0 && ` · ${turns.length} turns`}
            </p>
          </div>
          <button onClick={onClose} className="close-button" aria-label="Close transcript" autoFocus>
            ✕
          </button>
        </header>
        <div className="transcript-thread">
          {turns.length ? (
            turns.map((turn, n) =>
              turn.speaker ? (
                <div key={n} className={`bubble-row ${turn.speaker === "AI" ? "bubble-row-ai" : ""}`}>
                  <span className="bubble-speaker">{turn.speaker === "AI" ? "Lifeline AI" : "Caller"}</span>
                  <p className="bubble">{turn.text}</p>
                </div>
              ) : (
                <p key={n} className="bubble-note">{turn.text}</p>
              ),
            )
          ) : (
            <p className="bubble-note">No transcript available for this report.</p>
          )}
        </div>
      </div>
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  peopleCount: "People",
  reportedPosition: "Position",
  reportedAddress: "Location",
  waterReport: "Water level",
  hazard: "Hazard",
  riskFactor: "Risk factor",
};

/** Facts the caller later changed or took back, newest first, without repeats of the same old value. */
function FactHistory({ changes }: { changes: NonNullable<Incident["factHistory"]> }) {
  const seen = new Set<string>();
  const rows = [...changes]
    .reverse()
    .filter((c) => {
      const key = `${c.field}:${c.previous.trim().toLowerCase()}:${c.withdrawnBy != null}`;
      return !seen.has(key) && seen.add(key);
    });
  const previous = (c: (typeof rows)[number]) =>
    capitalize(c.field === "riskFactor" ? (FACTOR_LABEL[c.previous as keyof typeof FACTOR_LABEL] ?? c.previous) : c.previous);
  return (
    <details>
      <summary>Changed by caller ({rows.length})</summary>
      <ul className="reason-list">
        {rows.map((c, n) => (
          <li key={n}>
            <span>
              <span className="mr-2 text-[11px] uppercase tracking-wide text-slate-500">{FIELD_LABEL[c.field] ?? c.field}</span>
              {c.withdrawnBy != null ? "Withdrawn: " : "Was: "}
              {previous(c)}
            </span>
            {(c.withdrawnBy ?? c.evidence) && <q>{c.withdrawnBy ?? c.evidence}</q>}
          </li>
        ))}
      </ul>
    </details>
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

  const override = priority.overrideReason != null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">
        {override ? (
          <>
            Set to <b className="text-slate-200">{priority.tier}</b> by the dispatcher (the rules say {priority.computedTier}):{" "}
            &ldquo;{priority.overrideReason}&rdquo;
          </>
        ) : (
          "Worked out from what the caller said:"
        )}
      </p>
      {unique.length || modelReasons.length ? (
        <ul className="reason-list">
          {unique.map((f) => (
            <li key={f.factor}>
              <span>
                {capitalize(FACTOR_LABEL[f.factor])}
                {f.fromLinked && <span className="ml-1.5 text-[11px] text-slate-500">linked report</span>}
              </span>
              {f.evidence && <q>{f.evidence}</q>}
            </li>
          ))}
          {modelReasons.map((r) => (
            <li key={r}>
              <span className="text-sky-300">{capitalize(r)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">No risk factors reported yet.</p>
      )}
      <form
        className="override-form"
        onSubmit={(e) => {
          e.preventDefault();
          run({ type: "setPriorityOverride", incidentId: incident.id, tier, reason });
          setReason("");
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="Priority tier">
          {(["critical", "high", "standard"] as PriorityTier[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={tier === t} data-tier={t} onClick={() => setTier(t)}>
              {tier === t && <span aria-hidden>✓</span>}
              {capitalize(t)}
              {t === priority.tier && tier !== t && <span className="segmented-now">now</span>}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for changing"
            aria-label="Reason for changing the priority"
            className="field-input min-w-0 flex-1"
          />
          <button type="submit" disabled={!reason.trim()} className="soft-button">
            Override
          </button>
        </div>
      </form>
      {override && (
        <button
          onClick={() => run({ type: "setPriorityOverride", incidentId: incident.id, tier: null, reason: "" })}
          className="text-xs text-slate-400 underline hover:text-slate-200"
        >
          Use the rules again
        </button>
      )}
    </div>
  );
}

const ROLE_LABEL = { trapped: "Trapped caller", witness: "Witness", unknown: "Caller" } as const;

function GroupBadges({ incident, all, linked }: { incident: Incident; all: Incident[]; linked: number }) {
  if (!isOpen(incident)) return linked ? <span className="chip chip-neutral">+{linked} linked</span> : null;
  const nearby = nearbyReports(incident, all);
  const likely = nearby.filter((n) => n.relation !== "separate_rescue").length;
  const { rescues } = buildingSummary(incident, nearby);
  return (
    <>
      {incident.callerRole === "witness" && (
        <span className="chip chip-neutral">Witness</span>
      )}
      {linked > 0 && (
        <span className="chip chip-blue">+{linked} linked reports</span>
      )}
      {likely > 0 && (
        <span className="chip chip-orange">
          {likely} possible duplicate{likely > 1 ? "s" : ""}
        </span>
      )}
      {rescues > 1 && (
        <span className="chip chip-violet">
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
    <div className="sheet-card space-y-2 text-xs">
      <h3>At this building</h3>
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
            {capitalize(other.reportedAddress)} · {other.peopleCount ?? "?"} people · {other.reportedPosition ?? "position unknown"}
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
                    {ROLE_LABEL[r.callerRole ?? "unknown"]}: {capitalize(r.reportedAddress)}
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

const UPDATE_STATE: Record<"spoken" | "waiting" | "replaced" | "not delivered", { label: string; chip: string }> = {
  spoken: { label: "Spoken", chip: "chip-green" },
  waiting: { label: "Queued", chip: "chip-amber" },
  replaced: { label: "Superseded", chip: "chip-neutral" },
  "not delivered": { label: "Not delivered", chip: "chip-neutral" },
};

/** What the voice agent has told (or will tell) the caller, live from Convex, plus a box to send a message. */
function CallerUpdates({ incident, run }: { incident: Incident; run: Run }) {
  const updates = useQuery(api.incidents.callerUpdates, {
    dispatcherToken: currentDispatcherToken(),
    incidentId: incident.id as Id<"incidents">,
  });
  const [message, setMessage] = useState("");

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-xs text-slate-400">
        {incident.callConnected ? (
          <>
            <i className="live-dot" /> Live: updates appear here as the agent speaks them.
          </>
        ) : (
          "The call has ended. Updates not yet spoken were not delivered."
        )}
      </p>
      {updates === undefined ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : updates.length ? (
        <ol className="update-list">
          {updates.map((u) => (
            <li key={u.id} className={u.state === "spoken" || u.state === "waiting" ? undefined : "is-faded"}>
              <div className="flex items-center gap-2">
                <span className={`chip ${UPDATE_STATE[u.state].chip}`}>{UPDATE_STATE[u.state].label}</span>
                <time className="font-mono text-[11px] text-slate-500">
                  {new Date(u.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
              </div>
              <p className={u.state === "replaced" ? "line-through" : undefined}>{u.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-slate-500">Nothing has been said to the caller yet.</p>
      )}
      {incident.callConnected && (
        <form
          className="flex gap-1.5"
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
            placeholder="Message read to the caller word for word"
            className="field-input min-w-0 flex-1"
          />
          <button type="submit" className="soft-button" disabled={!message.trim()}>
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
    <div>
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
    </div>
  );
}

/** Whether a point lies inside the area the flood model covers; callers' reports outside it can't be drawn. */
function inFloodArea({ west, east, south, north }: Bounds, longitude: number, latitude: number) {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function riverDepthAt(grid: FloodGrid | null, riverFlood: FloodResult | null, incident: Incident) {
  if (!grid || !riverFlood || incident.latitude == null || incident.longitude == null) return null;
  return depthAt(grid, riverFlood, incident.longitude, incident.latitude);
}

/** Flags a gap at least this big between the caller and the river model. */
const DISAGREE_M = 0.3;

function CallerWater({
  report,
  riverDepth,
  verified,
  outsideModel,
}: {
  report: NonNullable<Incident["waterReport"]>;
  riverDepth: number | null;
  verified: boolean;
  outsideModel: boolean;
}) {
  const floor = report.floor ?? 0;
  // Depth above the street, to compare with the model.
  const callerDepth = report.meters + floor * FLOOR_HEIGHT_M;
  const gap = riverDepth == null ? null : callerDepth - riverDepth;
  const vague = report.level === "present";
  const notes = [
    vague ? `no depth given, ~${report.meters.toFixed(1)} m assumed` : null,
    ["measured", "estimated", "present"].includes(report.level) ? null : `~${report.meters.toFixed(1)} m`,
    floor > 0 ? `on floor ${floor}, ~${callerDepth.toFixed(1)} m above the street` : null,
  ].filter(Boolean);
  return (
    <div className="rounded bg-slate-800/70 p-2.5 text-xs">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Caller vs. river model</div>
      <p>
        Caller: <b className="text-sky-300">{describeReport(report)}</b>
        {notes.length > 0 && ` (${notes.join(", ")})`}
        {report.evidence && <span className="text-slate-400"> — &ldquo;{report.evidence}&rdquo;</span>}
      </p>
      {outsideModel ? (
        <p className="mt-1 text-amber-300">
          This location is outside the area the flood model covers, so the caller&apos;s report isn&apos;t drawn on the
          map. Check that the incident is on the right building.
        </p>
      ) : (
      <p>
        River model alone: <b>{riverDepth == null ? "loading…" : `${riverDepth.toFixed(1)} m`}</b>
      </p>
      )}
      {gap != null && !outsideModel &&
        (vague && gap < 0 ? (
          <p className="mt-1 text-slate-400">
            The model already has deeper water here. A report without a depth only adds water, so the model is kept.
          </p>
        ) : Math.abs(gap) >= DISAGREE_M ? (
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
