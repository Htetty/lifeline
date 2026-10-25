import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { RouteResult } from "../src/lib/planner";
import type { Priority } from "../src/lib/priority";
import type { ExerciseState, Incident, RescueTeam } from "../src/lib/types";

// The review panel's logic, rendered as a plain function with in-memory hooks and a mocked
// store (no browser, map or service). Complements scripts/qa/planner_panel.cjs.

const hooks = vi.hoisted(() => {
  const h = { values: [] as unknown[], cursor: 0 };
  return {
    h,
    useMemo: (fn: () => unknown) => fn(),
    useState(initial: unknown) {
      const k = h.cursor++;
      if (!(k in h.values)) h.values[k] = initial;
      return [h.values[k], (next: unknown) => (h.values[k] = typeof next === "function" ? next(h.values[k]) : next)];
    },
  };
});
// Effects (the panel suggesting on open) don't run here; tests press "Suggest assignments" themselves.
vi.mock("react", () => ({ useEffect: () => {}, useMemo: hooks.useMemo, useRef: (current: unknown) => ({ current }), useState: hooks.useState }));
const store = vi.hoisted(() => ({
  recordProposal: vi.fn(),
  approvePlan: vi.fn(),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/store", () => store);

const { AssignmentPlanner } = await import("../src/components/AssignmentPlanner");

type El = ReactElement<{ children?: ReactNode; onClick?: () => void; onChange?: () => void; disabled?: boolean }>;
const nodes = (n: ReactNode): El[] => {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (!n || typeof n !== "object" || !("props" in n)) return [];
  const el = n as El;
  // Function components (ProposalCard etc.) are expanded so their buttons are reachable.
  const expanded = typeof el.type === "function" ? (el.type as (p: unknown) => ReactNode)(el.props) : el.props.children;
  return [el, ...nodes(expanded)];
};
const text = (n: ReactNode): string =>
  Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" && "props" in n ? text((n as El).props.children) : typeof n === "string" || typeof n === "number" ? String(n) : "";

const incident = (id: string, k: number): Incident => ({
  id, exerciseId: "x", callId: null, source: "map_report", reportedAddress: `${id} Fictional Way`, latitude: 32.76,
  longitude: -117.17, locationVerified: true, peopleCount: 2, reportedPosition: "roof", hazards: [], summary: "",
  transcript: null, status: "awaiting_assignment", assignedTeamId: null, callConnected: false, createdAt: k, updatedAt: k, version: 1,
});
const team = (id: string): RescueTeam => ({
  id, name: `Truck ${id}`, latitude: 32.75, longitude: -117.17, available: true, capabilities: ["road_vehicle"],
  currentAssignment: null, updatedAt: 0, simulated: true, trip: null,
});
const route = (): RouteResult => ({
  ok: true, mover: "road_vehicle", realSeconds: 600, path: [[-117.17, 32.75], [-117.17, 32.755], [-117.17, 32.76]],
  legs: [{ mode: "road", end: 2 }], maxDepth: 0, limit: 0.3, metres: { road: 1100, foot: 0, water: 0, air: 0 },
});

function fixture() {
  hooks.h.values = [];
  const incidents = [incident("a", 1), incident("b", 2)];
  const props = {
    state: { waterSurfaceElevation: 9, waterObservedAt: null, incidents, teams: [team("1"), team("2")] } as unknown as ExerciseState,
    priorities: new Map<string, Priority>(incidents.map((i) => [i.id, { tier: "standard", reasons: [] } as unknown as Priority])),
    routeFor: route,
    routeContext: "loaded",
    notReady: null as string | null,
    onPreview() {}, onSelectIncident() {}, onDone() {}, onClose() {},
  };
  const render = () => {
    hooks.h.cursor = 0;
    return nodes(AssignmentPlanner(props));
  };
  const button = (label: string) => render().find((n) => n.type === "button" && text(n.props.children).includes(label))!;
  const checkbox = (k: number) => render().filter((n) => n.type === "input")[k];
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { props, render, button, checkbox, flush };
}

beforeEach(() => {
  store.recordProposal.mockReset().mockResolvedValue({ matched: true });
  store.approvePlan.mockReset();
});

test("a retry reuses the approval ID only for the same selection", async () => {
  const f = fixture();
  f.button("Suggest assignments").props.onClick!();
  await f.flush();
  store.approvePlan.mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network"));
  f.button("Approve 2 selected").props.onClick!();
  await f.flush();
  f.button("Approve 2 selected").props.onClick!(); // retry, same selection
  await f.flush();
  f.checkbox(1).props.onChange!(); // selection changes
  store.approvePlan.mockResolvedValueOnce({ ok: true, outcome: "approved", assigned: 1 });
  f.button("Approve 1 selected").props.onClick!();
  await f.flush();
  const ids = store.approvePlan.mock.calls.map(([a]) => a.approvalId);
  const sizes = store.approvePlan.mock.calls.map(([a]) => a.selected.length);
  expect(sizes).toEqual([2, 2, 1]);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

test("the proposal is recorded with the routes and flood the dispatcher sees", async () => {
  const f = fixture();
  f.button("Suggest assignments").props.onClick!();
  await f.flush();
  const recorded = store.recordProposal.mock.calls[0][0];
  expect(recorded.floodFingerprint).toMatch(/^[0-9a-f]{16}$/);
  expect(recorded.proposals.map((p: { seconds: number; evidence: { realSeconds: number } }) => [p.seconds, p.evidence.realSeconds])).toEqual([
    [600, 600],
    [600, 600],
  ]);
});

test("a pending location edit, or a change in the local route model, blocks approval", async () => {
  const f = fixture();
  f.button("Suggest assignments").props.onClick!();
  await f.flush();
  expect(f.button("Approve 2 selected").props.disabled).toBe(false);
  f.props.notReady = "Finish or cancel the location you're placing on the map, then suggest.";
  expect(f.button("Approve 2 selected").props.disabled).toBe(true);
  f.props.notReady = null;
  f.props.routeContext = "roads reloaded";
  expect(f.button("Approve 2 selected").props.disabled).toBe(true);
});

test("only a change to a proposed incident or team, or a big river move, stales the plan on screen", async () => {
  const f = fixture();
  f.button("Suggest assignments").props.onClick!();
  await f.flush();
  // Changes elsewhere (a new report, the river moving a little) don't block approval.
  const other = { ...incident("r", 3), status: "resolved" as const, waterReport: { level: "chest", floor: 0, evidence: "chest deep", measuredMeters: null } };
  f.props.state = { ...f.props.state, waterSurfaceElevation: 9.2, incidents: [...f.props.state.incidents, other] } as ExerciseState;
  expect(f.button("Approve 2 selected").props.disabled).toBe(false);
  // Unchecking the changed incident's proposal lets the rest be approved.
  const [a, b] = f.props.state.incidents;
  f.props.state = { ...f.props.state, incidents: [{ ...a, peopleCount: 5 }, b, other] } as ExerciseState;
  expect(f.button("Approve 2 selected").props.disabled).toBe(true);
  f.checkbox(0).props.onChange!();
  expect(f.button("Approve 1 selected").props.disabled).toBe(false);
  f.props.state = { ...f.props.state, waterSurfaceElevation: 9.5 } as ExerciseState;
  expect(f.button("Approve 1 selected").props.disabled).toBe(true);
});

test("a failed record for an earlier plan doesn't show on the current one", async () => {
  const f = fixture();
  let failOld!: (e: Error) => void;
  store.recordProposal.mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)));
  f.button("Suggest assignments").props.onClick!();
  f.button("Suggest again").props.onClick!();
  await f.flush();
  failOld(new Error("OLD plan failed to record"));
  await f.flush();
  expect(text(f.render().map((n) => n.props.children))).not.toMatch(/OLD plan failed/);
  expect(f.button("Approve 2 selected").props.disabled).toBe(false);
});
