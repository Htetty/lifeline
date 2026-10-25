import { describe, expect, test } from "vitest";
import { checkRouteEvidence, MAX_ROUTE_POINTS } from "../convex/planning";
import { EXERCISE_BOUNDS } from "../convex/seedData";
import { computeFlood, type FloodGrid } from "../src/lib/flood";
import { describePlan, evidenceFor, planAssignments, type RouteResult } from "../src/lib/planner";
import type { Priority } from "../src/lib/priority";
import { buildGraph, planRoute, type NoRoute, type RoutePlan } from "../src/lib/router";
import type { Incident, PriorityTier, RescueTeam } from "../src/lib/types";

// ---- fixtures ------------------------------------------------------------------------

let clock = 0;
function incident(id: string, extra: Partial<Incident> = {}): Incident {
  return {
    id, exerciseId: "x", callId: null, source: "map_report", reportedAddress: `${id} St (fictional)`,
    latitude: 32.76, longitude: -117.17, locationVerified: true, peopleCount: 2, reportedPosition: "second floor",
    hazards: [], summary: "", transcript: null, status: "awaiting_assignment", assignedTeamId: null,
    callConnected: false, createdAt: ++clock, updatedAt: clock, version: 1, ...extra,
  } as Incident;
}
function team(id: string, name: string, extra: Partial<RescueTeam> = {}): RescueTeam {
  return {
    id, name, latitude: 32.75, longitude: -117.17, available: true, capabilities: ["road_vehicle"],
    currentAssignment: null, updatedAt: 0, simulated: true, trip: null, ...extra,
  } as RescueTeam;
}
const priorities = (tiers: Record<string, PriorityTier>) =>
  new Map(Object.entries(tiers).map(([id, tier]) => [id, { tier, reasons: [] } as Priority]));
const ok = (seconds: number): RoutePlan => ({
  ok: true, mover: "road_vehicle", path: [[-117.17, 32.75], [-117.17, 32.755], [-117.17, 32.76]],
  legs: [{ mode: "road", end: 2 }], realSeconds: seconds, maxDepth: 0, limit: 0.3,
  metres: { road: 1100, water: 0, foot: 0, air: 0 },
});
const none = (reason = "every way in crosses water deeper than a road vehicle can handle (0.3 m)"): NoRoute => ({
  ok: false, mover: "road_vehicle", reason,
});
/** Route table: times[incidentId][teamId] = seconds | "none" | "unknown". */
function routes(times: Record<string, Record<string, number | "none" | "unknown">>) {
  return (t: RescueTeam, i: Incident): RouteResult => {
    const v = times[i.id]?.[t.id] ?? "none";
    return v === "unknown" ? null : v === "none" ? none() : ok(v);
  };
}
const pairs = (plan: ReturnType<typeof planAssignments>) =>
  Object.fromEntries(plan.proposals.map((p) => [p.incident.id, p.team.id]));

// ---- objective -----------------------------------------------------------------------

describe("whole-queue objective", () => {
  test("covers the higher-priority incident even when the team is closer to a lower one", () => {
    const plan = planAssignments({
      incidents: [incident("low"), incident("crit")],
      teams: [team("t1", "Truck 1")],
      priorities: priorities({ low: "standard", crit: "critical" }),
      route: routes({ low: { t1: 60 }, crit: { t1: 900 } }),
    });
    expect(pairs(plan)).toEqual({ crit: "t1" });
    expect(plan.unassigned.find((u) => u.incident.id === "low")?.reason).toMatch(/proposed for/);
  });

  test("keeps the only team that can reach an incident for it (scarce capability)", () => {
    // Greedy nearest-team-by-priority would send the boat to A (fastest there) and leave B with nothing.
    const plan = planAssignments({
      incidents: [incident("A"), incident("B")],
      teams: [team("boat", "Boat 1", { capabilities: ["boat"] }), team("truck", "Truck 1")],
      priorities: priorities({ A: "critical", B: "critical" }),
      route: routes({ A: { boat: 120, truck: 600 }, B: { boat: 400, truck: "none" } }),
    });
    expect(pairs(plan)).toEqual({ A: "truck", B: "boat" });
    expect(plan.proposals.find((p) => p.incident.id === "B")!.reason).toMatch(/only available team/);
    expect(plan.proposals.find((p) => p.incident.id === "A")!.reason).toBe(
      "Boat 1 would be faster (2 min vs 10 min), but sending it here would leave a critical incident without a team (B St (fictional)). Covering more incidents of each priority, most urgent first, comes before travel time.",
    );
    expect(plan.unassigned.filter((u) => u.incident.status === "awaiting_assignment")).toEqual([]);
  });

  test("among plans covering the same incidents, takes the least total travel time", () => {
    const plan = planAssignments({
      incidents: [incident("A"), incident("B")],
      teams: [team("t1", "Truck 1"), team("t2", "Truck 2")],
      priorities: priorities({ A: "high", B: "high" }),
      route: routes({ A: { t1: 100, t2: 200 }, B: { t1: 150, t2: 1000 } }),
    });
    // A→t1 + B→t2 = 1100; A→t2 + B→t1 = 350.
    expect(pairs(plan)).toEqual({ A: "t2", B: "t1" });
    expect(plan.totalSeconds).toBe(350);
  });

  test("the critical incident gets the faster team even when total travel is longer", () => {
    // Heli→high + Truck→crit = 60 + 900 = 960 s total; Heli→crit + Truck→high = 300 + 700 = 1000 s.
    const plan = planAssignments({
      incidents: [incident("crit"), incident("high")],
      teams: [team("heli", "Heli 1", { capabilities: ["air"] }), team("truck", "Truck 1")],
      priorities: priorities({ crit: "critical", high: "high" }),
      route: routes({ crit: { heli: 300, truck: 900 }, high: { heli: 60, truck: 700 } }),
    });
    expect(pairs(plan)).toEqual({ crit: "heli", high: "truck" });
    expect(plan.proposals.find((p) => p.incident.id === "high")!.reason).toBe(
      "Heli 1 would be faster (1 min vs 12 min), but sending it here would add 10 min of simulated travel for critical incidents overall (15 min instead of 5 min). Travel time is kept lowest for the most urgent incidents first.",
    );
  });

  test("ties break the same way regardless of input order", () => {
    const make = (reverse: boolean) => {
      const incs = [incident("A", { createdAt: 1 }), incident("B", { createdAt: 2 })];
      const tms = [team("t-b", "Bravo"), team("t-a", "Alpha")];
      return planAssignments({
        incidents: reverse ? [...incs].reverse() : incs,
        teams: reverse ? [...tms].reverse() : tms,
        priorities: priorities({ A: "high", B: "high" }),
        route: routes({ A: { "t-a": 100, "t-b": 100 }, B: { "t-a": 100, "t-b": 100 } }),
      });
    };
    expect(pairs(make(false))).toEqual({ A: "t-a", B: "t-b" }); // older incident gets the team first by name
    expect(pairs(make(true))).toEqual(pairs(make(false)));
    expect(describePlan(make(true))).toBe(describePlan(make(false)));
  });
});

// ---- eligibility -----------------------------------------------------------------------

describe("eligibility and unknowns", () => {
  test("no usable route: left unassigned with the router's reason, never a guessed route", () => {
    const plan = planAssignments({
      incidents: [incident("A")],
      teams: [team("t1", "Truck 1")],
      priorities: priorities({ A: "critical" }),
      route: routes({ A: { t1: "none" } }),
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.unassigned[0].reason).toBe("No available team can reach it under the simulated flood.");
    expect(plan.unassigned[0].alternatives[0]).toMatchObject({ state: "no_route", seconds: null });
  });

  test("route data unavailable: cannot evaluate, and no plan is made", () => {
    const plan = planAssignments({
      incidents: [incident("A"), incident("B")],
      teams: [team("t1", "Truck 1")],
      priorities: priorities({ A: "critical", B: "high" }),
      route: () => null,
    });
    expect(plan.status).toBe("cannot_evaluate");
    expect(plan.proposals).toEqual([]);
    expect(plan.unassigned.map((u) => u.reason)).toEqual(["Cannot evaluate: route data unavailable.", "Cannot evaluate: route data unavailable."]);
  });

  test("a route that can't be evaluated never becomes eligible", () => {
    const plan = planAssignments({
      incidents: [incident("A")],
      teams: [team("t1", "Truck 1"), team("t2", "Truck 2")],
      priorities: priorities({ A: "critical" }),
      route: routes({ A: { t1: "unknown", t2: "none" } }),
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.unassigned[0].reason).toMatch(/Cannot evaluate some routes/);
  });

  test("only free teams, only primary waiting incidents with confirmed locations", () => {
    const plan = planAssignments({
      incidents: [
        incident("main"),
        incident("linked", { linkedTo: "main" } as Partial<Incident>),
        incident("assigned", { status: "assigned", assignedTeamId: "busy" }),
        incident("unconfirmed", { status: "needs_review", locationVerified: false }),
        incident("done", { status: "resolved" }),
      ],
      teams: [
        team("busy", "Busy", { available: false, currentAssignment: "assigned" }),
        team("moving", "Moving", { available: true, trip: { incidentId: "x" } as RescueTeam["trip"] }),
        team("free", "Free"),
      ],
      priorities: priorities({ main: "high", unconfirmed: "critical" }),
      route: () => ok(100),
    });
    expect(pairs(plan)).toEqual({ main: "free" });
    expect(plan.proposals[0].alternatives.map((o) => o.team.id)).toEqual(["free"]);
    expect(plan.unassigned.map((u) => [u.incident.id, u.reason])).toEqual([
      ["unconfirmed", "Location not confirmed yet. Confirm it on the map to include it in a plan."],
    ]);
  });

  test("flags operational facts the model doesn't have", () => {
    const plan = planAssignments({
      incidents: [incident("A", { peopleCount: null, reportedPosition: null, riskFactors: [{ factor: "serious_injury", evidence: "x" }] })],
      teams: [team("t1", "Truck 1")],
      priorities: priorities({ A: "critical" }),
      route: () => ok(100),
    });
    expect(plan.proposals[0].unknowns).toEqual([
      "Number of people unknown",
      "Medical need reported; team medical capability isn't modeled",
      "Where they are in the building is unknown",
    ]);
  });

  test("excluding a proposal and regenerating picks the next option, or explains why none", () => {
    const input = {
      incidents: [incident("A")],
      teams: [team("t1", "Truck 1"), team("t2", "Truck 2")],
      priorities: priorities({ A: "critical" }),
      route: routes({ A: { t1: 100, t2: 300 } }),
    };
    expect(pairs(planAssignments(input))).toEqual({ A: "t1" });
    expect(pairs(planAssignments({ ...input, excluded: new Set(["A|t1"]) }))).toEqual({ A: "t2" });
    const none = planAssignments({ ...input, excluded: new Set(["A|t1", "A|t2"]) });
    expect(none.unassigned[0].reason).toBe("The teams that can reach it were excluded by the dispatcher.");
  });

  test("refuses a queue beyond its stated bounds instead of approximating", () => {
    const plan = planAssignments({
      incidents: [incident("A")],
      teams: Array.from({ length: 13 }, (_, k) => team(`t${k}`, `Truck ${k}`)),
      priorities: priorities({ A: "high" }),
      route: () => ok(100),
    });
    expect(plan.status).toBe("too_large");
    expect(plan.proposals).toEqual([]);
  });
});

// ---- with the real flood-aware router ---------------------------------------------------

describe("with the real flood-aware router", () => {
  // A north–south road crossing a low band of ground; the band floods first.
  const WEST = -117.175, EAST = -117.165, SOUTH = 32.755, NORTH = 32.765;
  const ROAD_LON = -117.17;
  const lats = Array.from({ length: 17 }, (_, k) => 32.756 + k * 0.0005);
  const roads = buildGraph({
    bounds: { south: SOUTH, north: NORTH },
    classes: ["residential"],
    nodes: lats.flatMap((lat) => [ROAD_LON, lat]),
    edges: lats.slice(1).map((_, k) => [k, k + 1, 0, 0] as [number, number, number, number]),
  });
  const grid: FloodGrid = (() => {
    const dLat = 15 / 111_320, dLon = 15 / (111_320 * Math.cos((32.76 * Math.PI) / 180));
    const cols = Math.floor((EAST - WEST) / dLon), rows = Math.floor((NORTH - SOUTH) / dLat);
    const ground = new Float32Array(cols * rows).fill(10);
    const seeds: number[] = [];
    for (let c = 0; c < cols; c++) {
      let low = -1;
      for (let r = 0; r < rows; r++) {
        const lat = NORTH - (r + 0.5) * dLat;
        if (lat > 32.7595 && lat < 32.7605) {
          ground[r * cols + c] = 9;
          if (low < 0) low = r;
        }
      }
      seeds.push(low);
    }
    return { bounds: { west: WEST, east: EAST, south: SOUTH, north: NORTH }, cols, rows, dLon, dLat, ground, seeds,
      channel: new Float32Array(cols).fill(9), gaugeCol: 0 };
  })();
  const at = (level: number) => {
    const flood = computeFlood(grid, level);
    return (t: RescueTeam, i: Incident) => planRoute(roads, grid, flood, t, { longitude: i.longitude!, latitude: i.latitude! });
  };
  const north = () => incident("north", { longitude: -117.1702, latitude: 32.7635 });
  const south = () => incident("south", { longitude: -117.1702, latitude: 32.7572 });
  const truck = team("high", "High-Water 1", { capabilities: ["high_water_vehicle"], longitude: -117.1701, latitude: 32.7568 });
  const car = team("car", "Road 1", { capabilities: ["road_vehicle"], longitude: -117.1701, latitude: 32.7558 });

  test("0.5 m of water on the road: only the high-water truck can cross, so it goes north", () => {
    const plan = planAssignments({
      incidents: [south(), north()], // south waited longer: greedy would give it the nearest truck
      teams: [car, truck],
      priorities: priorities({ south: "critical", north: "critical" }),
      route: at(9.5),
    });
    expect(pairs(plan)).toEqual({ south: "car", north: "high" });
    const carToNorth = plan.proposals.find((p) => p.incident.id === "north")!.alternatives.find((o) => o.team.id === "car")!;
    expect(carToNorth).toMatchObject({ state: "no_route" });
    expect(carToNorth.note).toMatch(/deeper than a road vehicle can handle/);
    // Real router output passes the server's evidence check for the team and incident.
    for (const p of plan.proposals) expect(checkRouteEvidence(p.team, p.incident, p.evidence)).toBeNull();
  });

  test("water rises to 0.9 m: nothing can reach the north incident, and it stays unassigned", () => {
    const plan = planAssignments({
      incidents: [south(), north()],
      teams: [car, truck],
      priorities: priorities({ south: "critical", north: "critical" }),
      route: at(9.9),
    });
    expect(plan.proposals.map((p) => p.incident.id)).toEqual(["south"]);
    expect(plan.unassigned.find((u) => u.incident.id === "north")!.reason).toBe(
      "No available team can reach it under the simulated flood.",
    );
  });

  test("a fallback straight line or a too-deep route is rejected as evidence", () => {
    const plan = planAssignments({ incidents: [north()], teams: [truck], priorities: priorities({ north: "high" }), route: at(9.5) });
    const p = plan.proposals[0];
    expect(checkRouteEvidence(p.team, p.incident, { ...p.evidence, points: 2 })).toMatch(/straight-line/);
    expect(checkRouteEvidence(p.team, p.incident, { ...p.evidence, maxDepth: 0.9 })).toMatch(/deeper than the team's limit/);
    expect(checkRouteEvidence(p.team, p.incident, { ...p.evidence, modes: ["water"] })).toMatch(/travel this team can't do/);
    expect(checkRouteEvidence(p.team, p.incident, { ...p.evidence, realSeconds: 1 })).toMatch(/faster than the team can move/);
    expect(checkRouteEvidence(car, p.incident, p.evidence)).toMatch(/this team moves as a road_vehicle/);
  });
});

// ---- route evidence: geography and shape --------------------------------------------

describe("route evidence checks", () => {
  // The real road file's bounds (public/data/roads.json): the router scales distances by
  // the cosine of their middle latitude. Aircraft ignore roads, so no nodes are needed.
  const graph = buildGraph({ bounds: EXERCISE_BOUNDS, classes: [], nodes: [], edges: [] });
  const grid: FloodGrid = {
    bounds: { west: -117.169, east: -117.167, north: 32.763, south: 32.761 }, cols: 2, rows: 2, dLon: 0.001, dLat: 0.001,
    ground: new Float32Array(4).fill(10), seeds: [0, 1], channel: new Float32Array([9, 9]), gaugeCol: 0,
  };
  const { west, east, south, north } = EXERCISE_BOUNDS;
  const mid = (south + north) / 2;
  const flights: [string, [number, number], [number, number]][] = [
    ["south edge, east to west", [east, south], [west, south]],
    ["north edge, west to east", [west, north], [east, north]],
    ["corner to corner", [west, south], [east, north]],
    ["along the middle latitude", [west, mid], [east, mid]],
    ["short hop in the south", [-117.1625, 32.756], [-117.168, 32.762]],
    ["due north", [-117.16, south], [-117.16, north]],
  ];
  test("the exercise area is exactly the checked-in road graph's area", async () => {
    const roads = (await import("../public/data/roads.json")).default as { bounds: typeof EXERCISE_BOUNDS };
    expect(roads.bounds).toEqual(EXERCISE_BOUNDS);
  });

  for (const [what, from, to] of flights) {
    test(`a real helicopter route passes, and a slightly faster one doesn't: ${what}`, () => {
      const heli = team("heli", "Heli 1", { capabilities: ["air"], longitude: from[0], latitude: from[1] });
      const target = incident("target", { longitude: to[0], latitude: to[1] });
      const route = planRoute(graph, grid, computeFlood(grid, 9), heli, { longitude: target.longitude!, latitude: target.latitude! });
      if (!route.ok) throw new Error("expected an aircraft route");
      const evidence = evidenceFor(route);
      expect(checkRouteEvidence(heli, target, evidence)).toBeNull();
      // The speed check still bites: 1% faster than the aircraft can fly is refused.
      expect(checkRouteEvidence(heli, target, { ...evidence, realSeconds: evidence.realSeconds * 0.99 })).toMatch(/faster than the team can move/);
    });
  }

  test("malformed or out-of-area evidence is refused before anything else", () => {
    const heli = team("heli", "Heli 1", { capabilities: ["air"], longitude: -117.16, latitude: 32.76 });
    const target = incident("target", { longitude: -117.15, latitude: 32.77 });
    const route = planRoute(graph, grid, computeFlood(grid, 9), heli, { longitude: target.longitude!, latitude: target.latitude! });
    if (!route.ok) throw new Error("expected an aircraft route");
    const good = evidenceFor(route);
    const outside = team("far", "Far 1", { capabilities: ["air"], longitude: -117.2, latitude: 32.76 });
    expect(checkRouteEvidence(outside, target, { ...good, start: [-117.2, 32.76] })).toMatch(/start isn't a point in the exercise area/);
    expect(checkRouteEvidence(heli, target, { ...good, end: [-117.15, 32.8] })).toMatch(/end isn't a point in the exercise area/);
    expect(checkRouteEvidence(heli, target, { ...good, points: MAX_ROUTE_POINTS + 1 })).toMatch(/invalid number of points/);
    expect(checkRouteEvidence(heli, target, { ...good, points: 3 })).toMatch(/single direct flight/);
    expect(checkRouteEvidence(heli, target, { ...good, maxDepth: 0.1 })).toMatch(/single direct flight/);
    expect(checkRouteEvidence(heli, target, { ...good, modes: ["air", "air"] })).toMatch(/travel this team can't do/);
    expect(checkRouteEvidence(heli, target, { ...good, realSeconds: Number.MAX_VALUE * 2 })).toMatch(/no usable travel time/);
  });
});

describe("plan reasons describe the objective", () => {
  test("an equally fast team elsewhere is explained as a tie, not as faster", () => {
    const plan = planAssignments({
      incidents: [incident("A"), incident("B")],
      teams: [team("t1", "Truck 1"), team("t2", "Truck 2")],
      priorities: priorities({ A: "high", B: "high" }),
      route: routes({ A: { t1: 300, t2: 300 }, B: { t1: 300, t2: 300 } }),
    });
    expect(pairs(plan)).toEqual({ A: "t1", B: "t2" });
    expect(plan.proposals.find((p) => p.incident.id === "B")!.reason).toBe(
      "Truck 1 is just as fast (5 min), and the plan that sends it here is otherwise equal; equal plans are settled by queue order, each incident taking the team first by name.",
    );
  });

  test("an unassigned incident names who has each team and why it isn't moved", () => {
    const plan = planAssignments({
      incidents: [incident("crit"), incident("std")],
      teams: [team("t1", "Truck 1")],
      priorities: priorities({ crit: "critical", std: "standard" }),
      route: routes({ crit: { t1: 600 }, std: { t1: 60 } }),
    });
    expect(plan.unassigned.find((u) => u.incident.id === "std")!.reason).toBe(
      "Every team that can reach it is proposed for another incident (Truck 1: crit St (fictional) (critical)); sending one here would leave that incident without a team, and the plan covers the most incidents of each priority, most urgent first.",
    );
  });
});
