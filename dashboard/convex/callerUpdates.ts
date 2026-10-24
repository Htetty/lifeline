import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Everything the voice agent may tell a caller about progress, in one place.
// Wording only states what has been confirmed and saved: no arrival times,
// no promises beyond the current stage.

export const callerUpdateType = v.union(
  v.literal("details_received"),
  v.literal("location_confirmed"),
  v.literal("location_unclear"),
  v.literal("assignment_approved"),
  v.literal("assignment_changed"),
  v.literal("team_en_route"),
  v.literal("rescue_resolved"),
  v.literal("dispatcher_message"),
);

type UpdateType = Doc<"events">["type"];

export function announcementText(type: UpdateType, teamName: string | null, message?: string): string {
  const team = teamName ? `, ${teamName},` : "";
  switch (type) {
    case "details_received":
      return "I've passed your details to the dispatcher. Stay on the line with me.";
    case "location_confirmed":
      return "The dispatcher has confirmed your location and is arranging a rescue team.";
    case "location_unclear":
      return "I need to double-check exactly where you are so the team goes to the right place.";
    case "assignment_approved":
      return `Update from the dispatcher: a rescue team${team} has been assigned to you. Stay where you are, keep to the highest safe place, and keep your phone with you.`;
    case "assignment_changed":
      return "Update: the dispatcher is arranging a different rescue team for you. You're still in the queue; stay where you are.";
    case "team_en_route":
      return "Update: the rescue team is on its way to you now. Stay where you are and stay above the water.";
    case "rescue_resolved":
      return "The dispatcher has marked your rescue as complete. If you still need help, tell me now.";
    case "dispatcher_message":
      return `The dispatcher asked me to tell you: ${message ?? ""}`.trim();
  }
}

/** What the agent may say if the caller asks "is anyone coming?" right now. */
export function stageText(incident: Doc<"incidents">, teamName: string | null): string {
  const team = teamName ? ` (${teamName})` : "";
  switch (incident.status) {
    case "needs_review":
      return "Your details are with the dispatcher, who is confirming your location. No team has been assigned yet.";
    case "awaiting_assignment":
      return "The dispatcher has confirmed your location and is arranging a rescue team. No team has been assigned yet.";
    case "assigned":
      return `A rescue team${team} has been assigned to you. It hasn't been marked as on its way yet.`;
    case "en_route":
      return `The rescue team${team} is on its way to you. I don't have an arrival time.`;
    case "resolved":
      return "The dispatcher has marked your rescue as complete.";
  }
}

/**
 * Queue an update for the caller. Call only after the state change it describes is
 * saved in the same mutation. A newer progress update replaces any unspoken older
 * one ("latest wins"); dispatcher messages are never replaced.
 */
export async function queueCallerUpdate(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  type: UpdateType,
  options: { teamName?: string | null; message?: string } = {},
) {
  if (!incident.callId) return;
  const now = Date.now();
  if (type !== "dispatcher_message") {
    const pending = await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", incident.callId!).eq("announcedAt", null))
      .collect();
    for (const e of pending) {
      if (e.type !== "dispatcher_message") await ctx.db.patch(e._id, { announcedAt: now, supersededAt: now });
    }
  }
  const teamName = options.teamName ?? null;
  await ctx.db.insert("events", {
    exerciseId: incident.exerciseId,
    type,
    incidentId: incident._id,
    callId: incident.callId,
    teamName,
    text: announcementText(type, teamName, options.message),
    createdAt: now,
    announcedAt: null,
    supersededAt: null,
  });
}
