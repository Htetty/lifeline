import type { Incident } from "./types";

// Caller confirmation of the location, as dispatchers see it. Separate from
// `locationVerified`, which is the dispatcher's own check of the map pin.

export interface CallerLocationLabel {
  confirmed: boolean;
  /** Short badge text. */
  label: string;
  /** One line of detail: the caller's words, or what is still unconfirmed. */
  detail: string | null;
}

/** Null for incidents that didn't come from a call (map reports, fixtures). */
export function callerLocationLabel(incident: Incident): CallerLocationLabel | null {
  if (!incident.callId) return null;
  const state = incident.callerLocation;
  if (state?.status !== "confirmed") {
    return { confirmed: false, label: "Caller unconfirmed", detail: "Not confirmed by the caller yet." };
  }
  if (state.pending) {
    return {
      confirmed: true,
      label: "Caller confirmed",
      detail: `Unconfirmed newer location held: “${state.pending}”`,
    };
  }
  return { confirmed: true, label: "Caller confirmed", detail: state.evidence ? `Caller: “${state.evidence}”` : null };
}
