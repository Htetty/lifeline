import type { Doc } from "./_generated/dataModel";

// Caller confirmation of their location. The voice backend (backend/app/location_check.py)
// reads the location back and decides what the caller's answer means; these rules re-check
// every confirmation against the saved transcript and keep a confirmed location from being
// overwritten by a later extraction the caller never confirmed.

export type CallerLocation = NonNullable<Doc<"incidents">["callerLocation"]>;

export const UNCONFIRMED: CallerLocation = {
  status: "unconfirmed",
  pending: null,
  evidence: null,
  confirmedAt: null,
  mapIssue: null,
};

/** Exact words the agent uses to read a location back (same as location_check.readback). */
export const readBack = (location: string) => `I have ${location}. Is that correct?`;

/** Same place, ignoring case, spacing and punctuation (same as location_check.same). */
export const sameLocation = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
};

/**
 * Whether the transcript ends with the caller answering a read-back of `location` in
 * exactly the words `evidence`: the last agent line is that read-back, and only caller
 * lines follow it. A yes to any other question, or to a read-back the caller never
 * heard (interrupted playback isn't saved), never matches.
 */
export function answeredReadBack(transcript: string, location: string, evidence: string) {
  const lines = transcript.split("\n");
  const reply: string[] = [];
  let i = lines.length - 1;
  for (; i >= 0 && lines[i].startsWith("Caller: "); i--) reply.unshift(lines[i].slice("Caller: ".length));
  return (
    i >= 0 && lines[i].startsWith("Agent: ") && lines[i].endsWith(readBack(location)) &&
    reply.length > 0 && reply.join("\n") === evidence
  );
}

export interface LocationUpdate {
  /** Location from this turn's extraction, as the backend would read it back. */
  reportedAddress: string | null;
  locationChanged?: boolean;
  /** The backend's claim that the caller just said yes to a read-back of `location`. */
  locationConfirmation?: { location: string; evidence: string };
  /** Map-search problem from this turn; undefined when no search ran. */
  mapIssue?: string | null;
  transcript: string;
}

/**
 * Decide the caller-location state after one caller turn.
 * `address` is what to write to reportedAddress (null: leave it as it is) and `held` is
 * true when a different location was kept aside instead, so its map candidate is ignored too.
 */
export function applyCallerLocation(
  existing: Doc<"incidents">,
  current: string | null,
  args: LocationUpdate,
  now: number,
): { address: string | null; held: boolean; state: CallerLocation; notes: string[] } {
  const prev = existing.callerLocation ?? UNCONFIRMED;
  const confirmed = prev.status === "confirmed";
  // The location the caller is being asked to confirm.
  const awaiting = confirmed ? prev.pending : current;
  const incoming = args.reportedAddress;
  const notes: string[] = [];
  let address = incoming;
  let held = false;
  let state: CallerLocation = { ...prev };

  const c = args.locationConfirmation;
  if (
    c && awaiting != null && c.location === awaiting &&
    (incoming == null || sameLocation(incoming, awaiting)) &&
    answeredReadBack(args.transcript, awaiting, c.evidence)
  ) {
    state = { ...prev, status: "confirmed", pending: null, evidence: c.evidence, confirmedAt: now };
    address = awaiting;
    notes.push(`Caller confirmed the location: "${awaiting}".`);
  } else if (confirmed && incoming != null && current != null && !sameLocation(incoming, current)) {
    if (args.locationChanged) {
      // The caller took back the location they confirmed: it must be confirmed again.
      state = { ...UNCONFIRMED, mapIssue: prev.mapIssue };
      notes.push(`Caller changed their confirmed location to "${incoming}". Not confirmed by the caller yet.`);
    } else {
      // Not the caller correcting it: keep the confirmed location until they confirm this one.
      if (prev.pending == null || !sameLocation(prev.pending, incoming)) {
        notes.push(`Different location "${incoming}" held for caller confirmation; keeping caller-confirmed "${current}".`);
      }
      state = { ...prev, pending: incoming };
      address = null;
      held = true;
    }
  } else if (confirmed && incoming != null) {
    // A rewording of the confirmed location: keep the confirmed words.
    state = { ...prev, pending: null };
    address = null;
  }
  if (args.mapIssue !== undefined && !held) state.mapIssue = args.mapIssue;
  return { address, held, state, notes };
}
