"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { convex } from "./convex";
import type { ExerciseState, Incident, IncidentStatus, PriorityTier, RescueTeam } from "./types";

// Data adapter for the exercise, backed by Convex. Components read with
// useExercise() and write with dispatch(); both stay the same shape as the
// earlier local store.

export type Action =
  | { type: "setWaterLevel"; meters: number }
  | {
      type: "reportFromMap";
      latitude: number;
      longitude: number;
      peopleCount: number | null;
      reportedPosition: string | null;
      reportedAddress: string;
    }
  | { type: "verifyLocation"; incidentId: string; latitude?: number; longitude?: number }
  | { type: "assignTeam"; incidentId: string; teamId: string }
  | { type: "setStatus"; incidentId: string; status: IncidentStatus }
  | { type: "sendCallerMessage"; incidentId: string; message: string }
  | { type: "linkReports"; mainId: string; reportIds: string[] }
  | { type: "unlinkReport"; reportId: string }
  | { type: "markSeparate"; incidentId: string; otherId: string }
  | { type: "setPriorityOverride"; incidentId: string; tier: PriorityTier | null; reason: string }
  | { type: "reset" };

function toIncident(d: Doc<"incidents">): Incident {
  const { _id, _creationTime, ...rest } = d;
  void _creationTime;
  return { ...rest, id: _id };
}

function toTeam(d: Doc<"teams">): RescueTeam {
  const { _id, _creationTime, exerciseId, ...rest } = d;
  void _creationTime;
  void exerciseId;
  return { ...rest, id: _id };
}

// The dispatcher passcode is typed in at runtime and kept for this browser tab only,
// so it is never part of the bundle. Convex checks it against DISPATCHER_TOKEN.
const TOKEN_KEY = "lifeline.dispatcherToken";

function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let memoryToken: string | null = null;
const currentToken = () => memoryToken ?? storedToken() ?? "";
export const currentDispatcherToken = currentToken;
const tokenListeners = new Set<() => void>();

/**
 * Whether this deployment requires a dispatcher passcode. Open by default for the demo;
 * only a deployment with DISPATCHER_TOKEN set asks for one. null while checking.
 */
export function usePasscodeRequired(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    convex
      .query(api.exercise.get, {})
      .then(() => setRequired(false))
      .catch((e) => setRequired(e instanceof ConvexError && String(e.data).includes("passcode")));
  }, []);
  return required;
}

/** The dispatcher passcode for this tab, and a sign-in that checks it with Convex first. */
export function useDispatcherToken() {
  const token = useSyncExternalStore(
    (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    () => currentToken() || null,
    () => null,
  );
  const signIn = useCallback(async (candidate: string) => {
    await convex.query(api.exercise.get, { dispatcherToken: candidate });
    try {
      sessionStorage.setItem(TOKEN_KEY, candidate);
    } catch {
      // Private mode: the passcode lasts until the page reloads.
    }
    memoryToken = candidate;
    tokenListeners.forEach((l) => l());
  }, []);
  return { token, signIn };
}

/** Live exercise state, or undefined while loading / seeding. */
export function useExercise(token: string): ExerciseState | undefined {
  const data = useQuery(api.exercise.get, { dispatcherToken: token });
  const ensureSeeded = useMutation(api.exercise.ensureSeeded);

  useEffect(() => {
    if (data === null) void ensureSeeded({ dispatcherToken: token });
  }, [data, ensureSeeded, token]);

  return useMemo(() => {
    if (!data) return undefined;
    return {
      exerciseId: data.exercise.exerciseId,
      waterSurfaceElevation: data.exercise.waterSurfaceElevation,
      incidents: data.incidents.map(toIncident),
      teams: data.teams.map(toTeam),
      activity: data.activity.map((a) => ({ id: a._id, at: a.at, message: a.message, incidentId: a.incidentId })),
    };
  }, [data]);
}

const asIncident = (id: string) => id as Id<"incidents">;

export async function dispatch(action: Action): Promise<void> {
  const dispatcherToken = currentToken();
  switch (action.type) {
    case "setWaterLevel":
      await convex.mutation(api.exercise.setWaterLevel, { dispatcherToken, meters: action.meters });
      return;
    case "reportFromMap": {
      const { type, ...args } = action;
      void type;
      await convex.mutation(api.incidents.reportFromMap, { dispatcherToken, ...args });
      return;
    }
    case "verifyLocation":
      await convex.mutation(api.incidents.verifyLocation, {
        dispatcherToken,
        incidentId: asIncident(action.incidentId),
        latitude: action.latitude,
        longitude: action.longitude,
      });
      return;
    case "assignTeam":
      await convex.mutation(api.incidents.assignTeam, {
        dispatcherToken,
        incidentId: asIncident(action.incidentId),
        teamId: action.teamId as Id<"teams">,
      });
      return;
    case "setStatus":
      await convex.mutation(api.incidents.setStatus, {
        dispatcherToken,
        incidentId: asIncident(action.incidentId),
        status: action.status,
      });
      return;
    case "sendCallerMessage":
      await convex.mutation(api.incidents.sendCallerMessage, { dispatcherToken,
        incidentId: asIncident(action.incidentId),
        message: action.message,
      });
      return;
    case "linkReports":
      await convex.mutation(api.incidents.linkReports, { dispatcherToken,
        mainId: asIncident(action.mainId),
        reportIds: action.reportIds.map(asIncident),
      });
      return;
    case "unlinkReport":
      await convex.mutation(api.incidents.unlinkReport, { dispatcherToken, reportId: asIncident(action.reportId) });
      return;
    case "markSeparate":
      await convex.mutation(api.incidents.markSeparate, { dispatcherToken,
        incidentId: asIncident(action.incidentId),
        otherId: asIncident(action.otherId),
      });
      return;
    case "setPriorityOverride":
      await convex.mutation(api.incidents.setPriorityOverride, { dispatcherToken,
        incidentId: asIncident(action.incidentId),
        tier: action.tier,
        reason: action.reason,
      });
      return;
    case "reset":
      await convex.mutation(api.exercise.reset, { dispatcherToken });
      return;
  }
}

/** A readable message for a failed mutation (ConvexError data or a generic note). */
export function errorMessage(e: unknown): string {
  if (e instanceof ConvexError && typeof e.data === "string") return e.data;
  return "Couldn't save that change. Check the connection and try again.";
}
