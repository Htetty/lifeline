import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { checkRouteEvidence, type RouteEvidence } from "../convex/planning";
import { REGIONS } from "../convex/regions";
import schema from "../convex/schema";
import { buildBayGrid, computeFlood } from "../src/lib/flood";
import { gaugeFor, readingAt } from "../src/lib/gauge";
import type { ElevationGrid } from "../src/lib/elevation";

const modules = import.meta.glob("../convex/**/*.ts");
const dispatcherToken = "regions-fictional-dispatcher";
const secret = "regions-fictional-backend";
beforeEach(() => {
  vi.stubEnv("DISPATCHER_TOKEN", dispatcherToken);
  vi.stubEnv("BACKEND_SECRET", secret);
});

describe("switching the exercise region", () => {
  test("a reset moves the exercise, its teams and its water to the new region, and later resets stay there", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
    expect((await t.query(api.exercise.get, { dispatcherToken }))!.exercise.region).toBe("mission-valley");

    await t.mutation(api.exercise.reset, { dispatcherToken, region: "sf-waterfront" });
    const sf = (await t.query(api.exercise.get, { dispatcherToken }))!;
    const { bounds, water } = REGIONS["sf-waterfront"];
    expect(sf.exercise).toMatchObject({ region: "sf-waterfront", name: REGIONS["sf-waterfront"].name, waterSurfaceElevation: water.start.surface });
    expect(sf.teams.length).toBe(REGIONS["sf-waterfront"].teams.length);
    for (const team of sf.teams) {
      expect(team.longitude).toBeGreaterThan(bounds.west);
      expect(team.longitude).toBeLessThan(bounds.east);
    }

    await t.mutation(api.exercise.reset, { dispatcherToken, withSamples: true });
    // SF has no sample incidents: the reset stays in SF and starts empty.
    const again = (await t.query(api.exercise.get, { dispatcherToken }))!;
    expect(again.exercise.region).toBe("sf-waterfront");
    expect(again.incidents).toEqual([]);
  });

  test("the backend's map search is limited to the exercise region", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.ensureSeeded, { dispatcherToken, region: "sf-waterfront" });
    expect(await t.query(api.calls.exerciseArea, { secret })).toEqual(REGIONS["sf-waterfront"].bounds);
  });
});

test("route checks use the exercise region's area", () => {
  const team = { longitude: -122.39, latitude: 37.77, capabilities: ["air" as const] };
  const incident = { longitude: -122.395, latitude: 37.775 };
  const route: RouteEvidence = {
    mover: "air", realSeconds: 60, start: [team.longitude, team.latitude], end: [incident.longitude, incident.latitude],
    points: 2, modes: ["air"], maxDepth: 0, limit: null,
  };
  expect(checkRouteEvidence(team, incident, route, REGIONS["sf-waterfront"].bounds)).toBeNull();
  expect(checkRouteEvidence(team, incident, route, REGIONS["mission-valley"].bounds)).toMatch(/exercise area/);
});

test("a bay floods inland from open water to connected ground below the tide, not to low ground behind a ridge", () => {
  // West to east: bay (-5 m), shore (1 m), a ridge (6 m), then a hollow (0.5 m).
  const profile = [-5, -5, 1, 1, 6, 0.5, 0.5];
  const bounds = { west: -122.4, east: -122.4 + 0.0012 * 7, south: 37.77, north: 37.77 + 0.0004 };
  const elevation = { sample: (lon: number) => profile[Math.min(6, Math.floor((lon - bounds.west) / 0.0012))] } as unknown as ElevationGrid;
  const grid = buildBayGrid(elevation, bounds);
  const flood = computeFlood(grid, 2);
  const wetByCol = (c: number) => Array.from({ length: grid.rows }, (_, r) => flood.wet[r * grid.cols + c]).some(Boolean);
  const colOf = (lon: number) => Math.floor((lon - bounds.west) / grid.dLon);
  expect(wetByCol(colOf(bounds.west + 0.0012 * 2.5))).toBe(true); // the shore, 1 m under a 2 m tide
  expect(wetByCol(colOf(bounds.west + 0.0012 * 5.5))).toBe(false); // the hollow, cut off by the ridge
});

test("each region's replay starts where a reset puts the water", () => {
  for (const region of Object.values(REGIONS)) {
    const first = readingAt(gaugeFor(region.id), 0);
    expect(first.time).toBe(region.water.start.observedAt);
    expect(Math.round(first.surface * 100) / 100).toBe(region.water.start.surface);
  }
});
