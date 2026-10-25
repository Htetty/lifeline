import { GAUGE_READINGS } from "@/data/gaugeReplay";
import { TIDE_READINGS, TIDE_SEA_LEVEL_RISE_M } from "@/data/tideReplay";
import type { RegionId } from "../../convex/regions";

// Each region's flood is anchored to a real gauge, replayed from a recorded storm. Water
// surfaces are metres NAVD88, the same vertical datum as the USGS ground elevation.

const FEET = 0.3048;

export interface GaugeReading {
  index: number;
  time: number;
  /** Water surface at the gauge, metres NAVD88. */
  surface: number;
}

export interface Gauge {
  /** One word for the header, e.g. "River". */
  label: string;
  agency: string;
  site: string;
  name: string;
  /** What the replay is, for "during the …". */
  event: string;
  /** Short name of the replay, for its button. */
  replayName: string;
  readings: [time: number, surface: number][];
  /** The level the way it's read at this gauge, e.g. "14.2 ft". */
  display: (surface: number, digits?: number) => string;
}

// Mission Valley: USGS gauge height (ft above the gauge datum); + datum = NAVD88.
const FASHION_VALLEY_DATUM_FT = 16.48; // ±0.16 ft

const GAUGES: Record<RegionId, Gauge> = {
  "mission-valley": {
    label: "River",
    agency: "USGS",
    site: "11023000",
    name: "San Diego River at Fashion Valley",
    event: "Feb 27–28, 2017 storm (record peak 14.15 ft)",
    replayName: "2017 storm",
    readings: GAUGE_READINGS.map(([t, ft]) => [t, (FASHION_VALLEY_DATUM_FT + ft) * FEET]),
    display: (surface, digits = 1) => `${(surface / FEET - FASHION_VALLEY_DATUM_FT).toFixed(digits)} ft`,
  },
  "sf-waterfront": {
    label: "Bay",
    agency: "NOAA",
    site: "9414290",
    name: "San Francisco (Golden Gate) tide gauge",
    event: `Jan 27, 1983 record storm tide, plus a hypothetical ${TIDE_SEA_LEVEL_RISE_M} m of sea-level rise`,
    replayName: "1983 storm tide",
    readings: TIDE_READINGS,
    display: (surface, digits = 1) => `${surface.toFixed(digits)} m`,
  },
};

export function gaugeFor(region: RegionId): Gauge {
  return GAUGES[region];
}

export function readingAt(gauge: Gauge, index: number): GaugeReading {
  const i = Math.min(Math.max(0, index), gauge.readings.length - 1);
  const [time, surface] = gauge.readings[i];
  return { index: i, time, surface };
}

/** Index of the reading recorded at `time`, or -1. */
export function readingIndex(gauge: Gauge, time: number | null) {
  return time == null ? -1 : gauge.readings.findIndex(([t]) => t === time);
}

export function formatGaugeTime(time: number) {
  return new Date(time).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
