"use client";

import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { convex } from "./convex";
import type { ExerciseState, Incident, IncidentStatus, RescueTeam } from "./types";

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

/** Live exercise state, or undefined while loading / seeding. */
export function useExercise(): ExerciseState | undefined {
  const data = useQuery(api.exercise.get);
  const ensureSeeded = useMutation(api.exercise.ensureSeeded);

  useEffect(() => {
    if (data === null) void ensureSeeded();
  }, [data, ensureSeeded]);

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
  switch (action.type) {
    case "setWaterLevel":
      await convex.mutation(api.exercise.setWaterLevel, { meters: action.meters });
      return;
    case "reportFromMap": {
      const { type, ...args } = action;
      void type;
      await convex.mutation(api.incidents.reportFromMap, args);
      return;
    }
    case "verifyLocation":
      await convex.mutation(api.incidents.verifyLocation, {
        incidentId: asIncident(action.incidentId),
        latitude: action.latitude,
        longitude: action.longitude,
      });
      return;
    case "assignTeam":
      await convex.mutation(api.incidents.assignTeam, {
        incidentId: asIncident(action.incidentId),
        teamId: action.teamId as Id<"teams">,
      });
      return;
    case "setStatus":
      await convex.mutation(api.incidents.setStatus, {
        incidentId: asIncident(action.incidentId),
        status: action.status,
      });
      return;
    case "reset":
      await convex.mutation(api.exercise.reset, {});
      return;
  }
}

/** A readable message for a failed mutation (ConvexError data or a generic note). */
export function errorMessage(e: unknown): string {
  if (e instanceof ConvexError && typeof e.data === "string") return e.data;
  return "Couldn't save that change. Check the connection and try again.";
}
