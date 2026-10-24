import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { queueCallerUpdate } from "./callerUpdates";
import { logActivity } from "./lib";
import { EXERCISE_ID } from "./seedData";

// Grouping reports about the same people. Obvious duplicates are linked automatically
// (same room at the same building, or witnesses at a building with one rescue); everything
// else, including nearby pins or a matching floor and headcount, is left to the dispatcher
// as a suggestion. Every automatic link says why, is checked again whenever the caller's
// facts change, and can be undone.

/** Reports closer than this are candidates for the same building. */
export const SAME_PLACE_M = 35;
/** Pins this close are the same point (e.g. the same map-search match), not just neighbours. */
export const SAME_POINT_M = 5;
const AUTO = "Auto-linked";

/**
 * Save a change. A dispatcher decision (assignment, status, moving the pin, linking)
 * also moves decisionRevision on, which makes every update queued for the caller
 * before it stale. Returns the new decisionRevision.
 */
export async function bump(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  patch: Partial<Doc<"incidents">>,
  decision = false,
) {
  const decisionRevision = (incident.decisionRevision ?? 0) + (decision ? 1 : 0);
  await ctx.db.patch(incident._id, { ...patch, updatedAt: Date.now(), version: incident.version + 1, decisionRevision });
  return decisionRevision;
}

export async function linkedReports(ctx: MutationCtx, id: Id<"incidents">) {
  return await ctx.db
    .query("incidents")
    .withIndex("by_linkedTo", (q) => q.eq("linkedTo", id))
    .collect();
}

function distanceM(a: Doc<"incidents">, b: Doc<"incidents">) {
  const kx = 111_320 * Math.cos((a.latitude! * Math.PI) / 180);
  return Math.hypot((a.longitude! - b.longitude!) * kx, (a.latitude! - b.latitude!) * 111_320);
}

/** "room 312", "apt 4B" → "312" / "4b". */
function roomNumber(position: string | null) {
  const m = position?.toLowerCase().match(/\b(?:room|rm|apt|apartment|unit|suite)\s*#?\s*([0-9]{2,4}[a-z]?)\b/);
  return m ? m[1] : null;
}


/** "The Handlery Hotel, " → "handlery hotel". */
function addressKey(address: string) {
  return address.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\bthe\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Positive evidence that two pins are the same building, not merely neighbours: the same
 * address, the same map-search match, or the same point. Proximity alone is a suggestion.
 */
function sameBuilding(a: Doc<"incidents">, b: Doc<"incidents">) {
  if (a.latitude == null || b.latitude == null || distanceM(a, b) > SAME_PLACE_M) return false;
  if (distanceM(a, b) <= SAME_POINT_M) return true;
  if (addressKey(a.reportedAddress) === addressKey(b.reportedAddress)) return true;
  const match = (i: Doc<"incidents">) => (i.locationNote?.startsWith("Map search:") ? i.locationNote : null);
  return match(a) != null && match(a) === match(b);
}

/**
 * Why two trapped-caller reports are almost certainly the same people, or null. Only the
 * same room at the same building qualifies: a matching floor and headcount can be two
 * households, so that stays a suggestion for the dispatcher.
 */
function sameRescueReason(a: Doc<"incidents">, b: Doc<"incidents">): string | null {
  if (!sameBuilding(a, b)) return null;
  const [ra, rb] = [roomNumber(a.reportedPosition), roomNumber(b.reportedPosition)];
  return ra && rb && ra === rb ? `same room ${ra}` : null;
}

/** Whether an automatic link from `report` to `main` is still backed by the facts. */
function autoLinkHolds(report: Doc<"incidents">, main: Doc<"incidents">) {
  if (main.status === "resolved") return true; // history; nothing left to re-route
  if (report.callerRole === "witness") return sameBuilding(report, main);
  if (main.callerRole === "witness") return report.callerRole !== "trapped" && sameBuilding(report, main);
  return sameRescueReason(report, main) != null;
}

/** Make a linked report its own incident again: no inherited team, back to review. */
export async function unlink(ctx: MutationCtx, report: Doc<"incidents">, why: string) {
  if (!report.linkedTo) return;
  await bump(ctx, report, {
    linkedTo: null,
    linkNote: null,
    assignedTeamId: null,
    status: report.locationVerified ? "awaiting_assignment" : "needs_review",
  }, true);
  await logActivity(ctx, `${why}: "${report.reportedAddress}" is its own incident again. Check it.`, report._id);
}

/**
 * Re-check links after an incident's facts change (position, room, role, location).
 * Automatic links whose evidence is gone are undone, in both directions; links the
 * dispatcher made are kept but flagged.
 */
export async function reevaluateLinks(ctx: MutationCtx, incidentId: Id<"incidents">, changed: string) {
  const incident = await ctx.db.get(incidentId);
  if (!incident) return;
  const pairs: [Doc<"incidents">, Doc<"incidents">][] = [];
  if (incident.linkedTo) {
    const main = await ctx.db.get(incident.linkedTo);
    if (main) pairs.push([incident, main]);
  }
  for (const child of await linkedReports(ctx, incident._id)) pairs.push([child, incident]);
  for (const [report, main] of pairs) {
    if (autoLinkHolds(report, main)) continue;
    if (report.linkNote?.startsWith(AUTO)) {
      await unlink(ctx, report, `Automatic link removed after ${changed}`);
    } else {
      await logActivity(ctx, `${changed} for a report you linked; check that "${report.reportedAddress}" still belongs with "${main.reportedAddress}".`, report._id);
    }
  }
}

function isDispatched(i: Doc<"incidents">) {
  return i.status === "assigned" || i.status === "en_route";
}

function separated(a: Doc<"incidents">, b: Doc<"incidents">) {
  return Boolean(a.separateFrom?.includes(b._id) || b.separateFrom?.includes(a._id));
}

/** Which report stays the main one: dispatched, then confirmed, then a trapped caller, then oldest. */
export function pickMain(a: Doc<"incidents">, b: Doc<"incidents">): [Doc<"incidents">, Doc<"incidents">] {
  const score = (i: Doc<"incidents">) =>
    (isDispatched(i) ? 8 : 0) + (i.locationVerified ? 4 : 0) + (i.callerRole === "trapped" ? 2 : 0);
  if (score(a) !== score(b)) return score(a) > score(b) ? [a, b] : [b, a];
  // Oldest first; reports saved in the same millisecond fall back to insertion order.
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? [a, b] : [b, a];
  return a._creationTime <= b._creationTime ? [a, b] : [b, a];
}

/** Link `report` (and anything linked to it) under `main`. Callers checked validity. */
export async function linkInto(ctx: MutationCtx, main: Doc<"incidents">, report: Doc<"incidents">, note: string) {
  const team = main.assignedTeamId ? await ctx.db.get(main.assignedTeamId) : null;
  const follow = { linkedTo: main._id, status: main.status, assignedTeamId: main.assignedTeamId, linkNote: note };
  for (const child of await linkedReports(ctx, report._id)) await bump(ctx, child, follow, true);
  await bump(ctx, report, follow, true);
  await queueCallerUpdate(ctx, report, "report_linked", { teamName: team?.name ?? null });
  await logActivity(ctx, `${note}: "${report.reportedAddress}" grouped under "${main.reportedAddress}".`, report._id);
}

/**
 * Link an incident to obvious duplicates at the same building. Runs whenever an
 * incident's location or position changes. Leaves anything uncertain alone.
 */
export async function autoGroup(ctx: MutationCtx, incidentId: Id<"incidents">) {
  const incident = await ctx.db.get(incidentId);
  if (!incident || incident.linkedTo || incident.status === "resolved" || incident.latitude == null) return;

  const others = (
    await ctx.db
      .query("incidents")
      .withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID))
      .collect()
  ).filter(
    (o) =>
      o._id !== incident._id &&
      !o.linkedTo &&
      o.status !== "resolved" &&
      o.latitude != null &&
      !separated(incident, o) &&
      sameBuilding(incident, o),
  );
  if (!others.length) return;
  const rescues = others.filter((o) => o.callerRole !== "witness");

  if (incident.callerRole === "witness") {
    if (isDispatched(incident)) return;
    if (rescues.length === 1) {
      return linkInto(ctx, rescues[0], incident, `${AUTO}: witness at the only rescue in this building`);
    }
    if (rescues.length === 0) {
      // Only witnesses so far: keep them together under the first report.
      const first = others.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      if (first.createdAt < incident.createdAt) {
        return linkInto(ctx, first, incident, `${AUTO}: several witnesses reporting the same building`);
      }
    }
    return;
  }

  let current = incident;
  for (const other of rescues) {
    const reason = sameRescueReason(current, other);
    if (!reason) continue;
    const [main, report] = pickMain(current, other);
    if (isDispatched(report)) continue;
    await linkInto(ctx, main, report, `${AUTO}: ${reason}`);
    if (report._id === current._id) return; // this incident is now part of another one
    current = (await ctx.db.get(current._id))!;
  }

  // A trapped caller at a building that so far had only witness reports: they're the rescue.
  if (current.callerRole === "trapped" && rescues.length === 0) {
    for (const witness of others.filter((o) => o.callerRole === "witness" && !isDispatched(o))) {
      await linkInto(ctx, current, witness, `${AUTO}: witness reports at the only rescue in this building`);
    }
  }
}
