import { GAUGE_READINGS } from "@/data/gaugeReplay";

// The flood is anchored to a real stream gauge inside the demo area. Gauge height is
// measured from the gauge datum; adding the datum gives a water surface in NAVD88,
// the same vertical datum as the USGS ground elevation.

const FEET = 0.3048;

export const GAUGE = {
  site: "11023000",
  name: "San Diego River at Fashion Valley",
  longitude: -117.1686285,
  latitude: 32.76504955,
  datumFt: 16.48, // NAVD88, ±0.16 ft
  event: "Feb 27–28, 2017 storm (record peak 14.15 ft)",
};

/** Water surface at the gauge, metres NAVD88, for a gauge height in feet. */
export function stageToSurface(stageFt: number) {
  return (GAUGE.datumFt + stageFt) * FEET;
}

export function surfaceToStage(surface: number) {
  return surface / FEET - GAUGE.datumFt;
}

export interface GaugeReading {
  index: number;
  time: number;
  stageFt: number;
  surface: number;
}

export const REPLAY_LENGTH = GAUGE_READINGS.length;

export function readingAt(index: number): GaugeReading {
  const i = Math.min(Math.max(0, index), GAUGE_READINGS.length - 1);
  const [time, stageFt] = GAUGE_READINGS[i];
  return { index: i, time, stageFt, surface: stageToSurface(stageFt) };
}

/** Index of the reading recorded at `time`, or -1. */
export function readingIndex(time: number | null) {
  return time == null ? -1 : GAUGE_READINGS.findIndex(([t]) => t === time);
}

export function formatGaugeTime(time: number) {
  return new Date(time).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
