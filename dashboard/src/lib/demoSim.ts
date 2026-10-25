"use client";

import { useCallback, useEffect, useState } from "react";
import type { RegionId } from "../../convex/regions";
import { currentDispatcherToken } from "./store";

// The demo simulation runs on the voice backend (backend/app/simulation.py), which starts
// backend/scripts/demo_sim.py; the dashboard only starts, stops and watches it.
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const POLL_MS = 3000;

export interface DemoSimStatus {
  running: boolean;
  region?: RegionId;
  calls?: number;
  exitCode?: number | null;
  lastLine?: string | null;
}

async function call(path: string, body?: unknown): Promise<DemoSimStatus> {
  const res = await fetch(`${BACKEND_URL}/simulation${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentDispatcherToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail ?? `Backend returned ${res.status}`);
  return data;
}

/** The backend's demo simulation: null status while unknown or unreachable. Polls while `watch`. */
export function useDemoSim(watch: boolean) {
  const [status, setStatus] = useState<DemoSimStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const polling = watch || !!status?.running;

  useEffect(() => {
    if (!polling) return;
    let live = true;
    const refresh = () =>
      call("")
        .then((s) => live && (setStatus(s), setError(null)))
        .catch(() => live && (setStatus(null), setError(`Backend not reachable at ${BACKEND_URL}`)));
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [polling]);

  const act = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    try {
      setStatus(await call(path, body));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    error,
    busy,
    start: (region: RegionId) => act("/start", { region }),
    stop: () => act("/stop", {}),
  };
}
