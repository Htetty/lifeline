import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { queueCallerUpdate } from "./callerUpdates";
import { logActivity } from "./lib";
import { EXERCISE_ID } from "./seedData";

// Grouping reports about the same people. Obvious duplicates are linked automatically
// (same room, or same floor and headcount, or witnesses at a building with one rescue);
// everything else is left to the dispatcher. Every automatic link says why and can be undone.

/** Reports closer than this are treated as the same building. */
export const SAME_PLACE_M = 35;

const ORDINALS = ["ground", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export async function bump(ctx: MutationCtx, incident: Doc<"incidents">, patch: Partial<Doc<"incidents">>) {
  await ctx.db.patch(incident._id, { ...patch, updatedAt: Date.now(), version: incident.version + 1 });
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

/** "third floor" / "3rd floor" → "floor 3"; "roof" / "attic" as is. */
function floorKey(position: string | null) {
  if (!position) return null;
  const text = position.toLowerCase();
  if (/\broof\b/.test(text)) return "roof";
  if (/\battic\b/.test(text)) return "attic";
  const numbered = text.match(/(\d+)(?:st|nd|rd|th)?\s*floor/);
  if (numbered) return `floor ${Number(numbered[1])}`;
  const word = ORDINALS.findIndex((w) => new RegExp(`\\b${w}\\s+floor`).test(text));
  return word >= 0 ? `floor ${Math.max(1, word)}` : null;
}

/** Why two trapped-caller reports are almost certainly the same people, or null. */
function sameRescueReason(a: Doc<"incidents">, b: Doc<"incidents">): string | null {
  const [ra, rb] = [roomNumber(a.reportedPosition), roomNumber(b.reportedPosition)];
  if (ra && rb) return ra === rb ? `same room ${ra}` : null;
  const [fa, fb] = [floorKey(a.reportedPosition), floorKey(b.reportedPosition)];
  if (!ra && !rb && fa && fa === fb && a.peopleCount != null && a.peopleCount === b.peopleCount) {
    return `same ${fa}, ${a.peopleCount} people`;
  }
  return null;
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
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

/** Link `report` (and anything linked to it) under `main`. Callers checked validity. */
export async function linkInto(ctx: MutationCtx, main: Doc<"incidents">, report: Doc<"incidents">, note: string) {
  const team = main.assignedTeamId ? await ctx.db.get(main.assignedTeamId) : null;
  const follow = { linkedTo: main._id, status: main.status, assignedTeamId: main.assignedTeamId, linkNote: note };
  for (const child of await linkedReports(ctx, report._id)) await bump(ctx, child, follow);
  await bump(ctx, report, follow);
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
      distanceM(incident, o) <= SAME_PLACE_M,
  );
  if (!others.length) return;
  const rescues = others.filter((o) => o.callerRole !== "witness");

  if (incident.callerRole === "witness") {
    if (isDispatched(incident)) return;
    if (rescues.length === 1) {
      return linkInto(ctx, rescues[0], incident, "Auto-linked: witness at the only rescue in this building");
    }
    if (rescues.length === 0) {
      // Only witnesses so far: keep them together under the first report.
      const first = others.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      if (first.createdAt < incident.createdAt) {
        return linkInto(ctx, first, incident, "Auto-linked: several witnesses reporting the same building");
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
    await linkInto(ctx, main, report, `Auto-linked: ${reason}`);
    if (report._id === current._id) return; // this incident is now part of another one
    current = (await ctx.db.get(current._id))!;
  }

  // A trapped caller at a building that so far had only witness reports: they're the rescue.
  if (current.callerRole === "trapped" && rescues.length === 0) {
    for (const witness of others.filter((o) => o.callerRole === "witness" && !isDispatched(o))) {
      await linkInto(ctx, current, witness, "Auto-linked: witness reports at the only rescue in this building");
    }
  }
}
