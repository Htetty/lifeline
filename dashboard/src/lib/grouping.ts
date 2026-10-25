import type { Incident } from "./types";

// Suggestions for reports at the same building. The dispatcher decides; nothing
// here links incidents by itself.

/** Reports closer than this are treated as the same building. */
export const SAME_PLACE_M = 35;

export type Relation = "likely_same" | "possibly_same" | "separate_rescue";

export interface NearbyReport {
  incident: Incident;
  relation: Relation;
  reason: string;
}

const ORDINALS: Record<string, number> = {
  ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function distanceM(a: Incident, b: Incident) {
  const kx = 111_320 * Math.cos((a.latitude! * Math.PI) / 180);
  return Math.hypot((a.longitude! - b.longitude!) * kx, (a.latitude! - b.latitude!) * 111_320);
}

/** Numbers in a position ("third floor, room 312" → {3, 312}), plus "roof" etc. as words. */
function positionKeys(position: string | null) {
  if (!position) return null;
  const text = position.toLowerCase();
  const keys = new Set<string>(text.match(/\d+/g) ?? []);
  for (const [word, n] of Object.entries(ORDINALS)) if (text.includes(word)) keys.add(String(n));
  for (const place of ["roof", "attic", "basement", "lobby", "car", "vehicle"]) if (text.includes(place)) keys.add(place);
  return keys.size ? keys : null;
}

export function isOpen(i: Incident) {
  return i.status !== "resolved" && !i.linkedTo;
}

function classify(a: Incident, b: Incident): Omit<NearbyReport, "incident"> {
  if (a.callerRole === "witness" || b.callerRole === "witness") {
    return { relation: "likely_same", reason: "A witness reporting the same building" };
  }
  const pa = positionKeys(a.reportedPosition);
  const pb = positionKeys(b.reportedPosition);
  if (pa && pb) {
    const shared = [...pa].some((k) => pb.has(k));
    return shared
      ? { relation: "possibly_same", reason: `Same position: "${a.reportedPosition}" / "${b.reportedPosition}"` }
      : { relation: "separate_rescue", reason: `Different floor or room: "${a.reportedPosition}" / "${b.reportedPosition}"` };
  }
  return { relation: "possibly_same", reason: "Same building; floor or room not known for both" };
}

/** Other open reports at the same building as `target`, with how they probably relate. */
export function nearbyReports(target: Incident, all: Incident[]): NearbyReport[] {
  if (target.latitude == null || target.longitude == null) return [];
  return all
    .filter(
      (o) =>
        o.id !== target.id &&
        isOpen(o) &&
        o.latitude != null &&
        o.longitude != null &&
        !target.separateFrom?.includes(o.id) &&
        !o.separateFrom?.includes(target.id) &&
        distanceM(target, o) <= SAME_PLACE_M,
    )
    .map((o) => ({ incident: o, ...classify(target, o) }));
}

/**
 * Separate rescues at this building, counting reports with the same floor/room once
 * (several unlinked calls about room 312 are one rescue, not several).
 */
export function buildingSummary(target: Incident, nearby: NearbyReport[]) {
  const key = (i: Incident) => [...(positionKeys(i.reportedPosition) ?? new Set(["?"]))].sort().join(",");
  const groups = new Map<string, number>();
  for (const { incident, relation } of nearby) {
    if (relation !== "separate_rescue") continue;
    const k = key(incident);
    groups.set(k, Math.max(groups.get(k) ?? 0, incident.peopleCount ?? 0));
  }
  const people = (target.peopleCount ?? 0) + [...groups.values()].reduce((a, b) => a + b, 0);
  return { rescues: groups.size + 1, people };
}

/** Which report should stay the main one when two are linked. */
export function pickMain(a: Incident, b: Incident): [main: Incident, report: Incident] {
  const score = (i: Incident) =>
    (i.status === "assigned" || i.status === "en_route" ? 8 : 0) +
    (i.locationVerified ? 4 : 0) +
    (i.callerRole === "trapped" ? 2 : 0);
  const [sa, sb] = [score(a), score(b)];
  if (sa !== sb) return sa > sb ? [a, b] : [b, a];
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}
