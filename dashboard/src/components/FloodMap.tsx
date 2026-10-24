"use client";

import { useEffect, useRef } from "react";
import { Map as MLMap, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DEMO_AREA } from "@/data/fixtures";
import type { FloodResult } from "@/lib/flood";
import { distanceToPolygon, expandPolygon, interiorPoint, pointInPolygon, polygons } from "@/lib/geo";
import type { ExerciseState, Incident } from "@/lib/types";
import { ACTIVE_STATUSES, DISPATCHED_STATUSES } from "@/lib/types";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const BUILDING_SOURCE = { source: "openmaptiles", sourceLayer: "building" } as const;
const BUILDING_LAYER = "building-3d";
const INCIDENT_BUILDING_LAYER = "incident-buildings";
const SNAP_DISTANCE_M = 25;

// The bundler can't serve MapLibre's worker next to its chunk, so it is copied
// to public/ by the postinstall script.
setWorkerUrl("/maplibre-gl-worker.mjs");

type Polygon = number[][][];

export interface ResolvedBuilding {
  /** Footprints (with their extrusion range) containing the incident point. */
  footprints: { polygon: Polygon; height: number; base: number }[];
  height: number | null;
}

export interface BuildingPick {
  longitude: number;
  latitude: number;
  height: number | null;
}

interface Props {
  state: ExerciseState;
  flood: FloodResult | null;
  selectedId: string | null;
  reportMode: boolean;
  onSelect: (incidentId: string | null) => void;
  onReportBuilding: (pick: BuildingPick) => void;
  onBuildingsResolved: (resolved: Record<string, ResolvedBuilding>) => void;
}

type BuildingState = "stuck" | "dispatched" | "resolved";

function buildingStateFor(incident: Incident): BuildingState {
  if (ACTIVE_STATUSES.includes(incident.status)) return "stuck";
  if (DISPATCHED_STATUSES.includes(incident.status)) return "dispatched";
  return "resolved";
}

function incidentPoints(state: ExerciseState, selectedId: string | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: state.incidents
      .filter((i) => i.latitude != null && i.longitude != null)
      .map((i) => ({
        type: "Feature",
        id: i.id,
        properties: {
          id: i.id,
          kind: buildingStateFor(i),
          selected: i.id === selectedId,
          verified: i.locationVerified,
          label: `${i.priorityTier === "critical" && i.status !== "resolved" ? "CRITICAL · " : ""}${i.peopleCount ?? "?"} ${i.peopleCount === 1 ? "person" : "people"}${
            i.locationVerified ? "" : " · location unverified"
          }`,
        },
        geometry: { type: "Point", coordinates: [i.longitude!, i.latitude!] },
      })),
  };
}

function teamPoints(state: ExerciseState): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: state.teams.map((t) => ({
      type: "Feature",
      properties: { name: `${t.name}${t.available ? "" : " (busy)"}`, available: t.available },
      geometry: { type: "Point", coordinates: [t.longitude, t.latitude] },
    })),
  };
}

export default function FloodMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  const lastResolved = useRef("");

  useEffect(() => {
    propsRef.current = props;
  });

  // Find the building footprint under each incident and draw it as a coloured overlay.
  // Building tiles merge many footprints with the same height into one feature,
  // so this works per polygon rather than per feature id.
  const syncBuildings = useRef(() => {});
  useEffect(() => {
    syncBuildings.current = () => {
      const map = mapRef.current;
      if (!map || !readyRef.current) return;
      const { state, selectedId, onBuildingsResolved } = propsRef.current;
      const features = map.querySourceFeatures(BUILDING_SOURCE.source, {
        sourceLayer: BUILDING_SOURCE.sourceLayer,
      });

      const resolved: Record<string, ResolvedBuilding> = {};
      for (const incident of state.incidents) {
        const { latitude: lat, longitude: lon } = incident;
        if (lat == null || lon == null) continue;
        const found = new Map<string, ResolvedBuilding["footprints"][number]>();
        let nearest: { fp: ResolvedBuilding["footprints"][number]; d: number } | null = null;
        for (const f of features) {
          const height = Number(f.properties.render_height) || 0;
          const base = Number(f.properties.render_min_height) || 0;
          for (const polygon of polygons(f.geometry)) {
            if (pointInPolygon(lon, lat, polygon)) {
              // The same footprint appears once per tile that overlaps it.
              const [x, y] = polygon[0][0];
              found.set(`${x.toFixed(6)},${y.toFixed(6)},${height}`, { polygon, height, base });
            } else if (!found.size) {
              const d = distanceToPolygon(polygon, lon, lat);
              if (d < SNAP_DISTANCE_M && (!nearest || d < nearest.d)) nearest = { fp: { polygon, height, base }, d };
            }
          }
        }
        const footprints = found.size ? [...found.values()] : nearest ? [nearest.fp] : [];
        const height = footprints.length ? Math.max(...footprints.map((fp) => fp.height)) : null;
        resolved[incident.id] = { footprints, height };
      }

      // One overlay per footprint, coloured by its most urgent incident, so stacked
      // incidents on one building can't z-fight (a resolved one must never hide an active one).
      const byFootprint = new Map<string, GeoJSON.Feature>();
      for (const incident of state.incidents) {
        const kind = buildingStateFor(incident);
        const selected = incident.id === selectedId && kind !== "resolved";
        const rank = (kind === "stuck" ? 3 : kind === "dispatched" ? 2 : 1) * 2 + (selected ? 1 : 0);
        for (const fp of resolved[incident.id]?.footprints ?? []) {
          const [x, y] = fp.polygon[0][0];
          const key = `${x.toFixed(6)},${y.toFixed(6)},${fp.height},${fp.base}`;
          if ((byFootprint.get(key)?.properties?.rank ?? -1) >= rank) continue;
          byFootprint.set(key, {
            type: "Feature",
            properties: {
              incidentId: incident.id,
              kind: selected ? "selected" : kind,
              rank,
              height: fp.height + 0.4,
              base: fp.base,
            },
            geometry: { type: "Polygon", coordinates: expandPolygon(fp.polygon, 0.4) },
          });
        }
      }
      const overlay = [...byFootprint.values()];
      (map.getSource("incident-buildings") as GeoJSONSource).setData({ type: "FeatureCollection", features: overlay });

      const summary: Record<string, number | null> = {};
      for (const [id, r] of Object.entries(resolved)) summary[id] = r.height;
      const key = JSON.stringify(summary) + overlay.length;
      if (key !== lastResolved.current) {
        lastResolved.current = key;
        onBuildingsResolved(resolved);
      }
    };
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const map = new MLMap({
      container: container.current,
      style: STYLE_URL,
      center: DEMO_AREA.center,
      zoom: DEMO_AREA.zoom,
      pitch: DEMO_AREA.pitch,
      bearing: DEMO_AREA.bearing,
      maxPitch: 80,
      attributionControl: {
        compact: true,
        customAttribution:
          "Elevation: <a href='https://registry.opendata.aws/terrain-tiles/' target='_blank'>AWS Terrain Tiles</a> (USGS NED) · Flood extent simulated",
      },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    map.on("load", () => {
      // Recolor the existing basemap, preserving its tiles, buildings and overlays.
      for (const layer of map.getStyle().layers) {
        const name = layer.id.toLowerCase();
        if (layer.type === "background") {
          map.setPaintProperty(layer.id, "background-color", "#0b111c");
        } else if (layer.type === "fill") {
          map.setPaintProperty(layer.id, "fill-color",
            /water/.test(name) ? "#142b40" : /park|wood|grass|landcover/.test(name) ? "#132126" : "#101925");
        } else if (layer.type === "line") {
          map.setPaintProperty(layer.id, "line-color",
            /water/.test(name) ? "#25445a" : /boundary/.test(name) ? "#3b4860" : /casing/.test(name) ? "#141d2b" : "#465268");
        } else if (layer.type === "symbol" && layer.layout?.["text-field"]) {
          map.setPaintProperty(layer.id, "text-color", /place|city|town/.test(name) ? "#b3bfd0" : "#7f90a8");
          map.setPaintProperty(layer.id, "text-halo-color", "#0b111c");
        } else if (layer.type === "fill-extrusion") {
          map.setPaintProperty(layer.id, "fill-extrusion-color", "#253247");
        }
      }
      map.setPaintProperty(BUILDING_LAYER, "fill-extrusion-opacity", 0.92);

      map.addSource("incident-buildings", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: INCIDENT_BUILDING_LAYER,
        type: "fill-extrusion",
        source: "incident-buildings",
        paint: {
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-color": [
            "match", ["get", "kind"],
            "selected", "#ff1744",
            "stuck", "#c62828",
            "dispatched", "#f59e0b",
            "#4caf50",
          ],
          "fill-extrusion-opacity": 0.95,
        },
      });

      map.addSource("flood", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "flood-water",
        type: "fill-extrusion",
        source: "flood",
        paint: {
          "fill-extrusion-base": 0,
          "fill-extrusion-height": ["get", "depth"],
          "fill-extrusion-color": [
            "interpolate", ["linear"], ["get", "depth"],
            0, "#9fd8f5",
            1, "#4fb3e8",
            3, "#1f7fc4",
            6, "#174a8f",
          ],
          "fill-extrusion-opacity": 0.6,
        },
      });

      map.addSource("teams", { type: "geojson", data: teamPoints(propsRef.current.state) });
      map.addLayer({
        id: "teams-dot",
        type: "circle",
        source: "teams",
        paint: {
          "circle-radius": 7,
          "circle-color": ["case", ["get", "available"], "#2563eb", "#64748b"],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "teams-label",
        type: "symbol",
        source: "teams",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: { "text-color": "#1e3a8a", "text-halo-color": "#fff", "text-halo-width": 1.5 },
      });

      map.addSource("incidents", {
        type: "geojson",
        data: incidentPoints(propsRef.current.state, propsRef.current.selectedId),
      });
      map.addLayer({
        id: "incidents-halo",
        type: "circle",
        source: "incidents",
        filter: ["==", ["get", "selected"], true],
        paint: {
          "circle-radius": 18,
          "circle-color": "rgba(255, 23, 68, 0.18)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "incidents-dot",
        type: "circle",
        source: "incidents",
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "match", ["get", "kind"],
            "stuck", "#dc2626",
            "dispatched", "#f59e0b",
            "#16a34a",
          ],
          "circle-stroke-color": ["case", ["get", "verified"], "#fff", "#111"],
          "circle-stroke-width": 2.5,
        },
      });
      map.addLayer({
        id: "incidents-label",
        type: "symbol",
        source: "incidents",
        filter: ["!=", ["get", "kind"], "resolved"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
          "text-offset": [0, -1.6],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#7f1d1d", "text-halo-color": "#fff", "text-halo-width": 2 },
      });

      readyRef.current = true;
      const flood = propsRef.current.flood;
      if (flood) (map.getSource("flood") as GeoJSONSource).setData(flood.geojson);
      syncBuildings.current();
    });

    map.on("idle", () => syncBuildings.current());

    map.on("click", (e) => {
      const { reportMode, onReportBuilding, onSelect } = propsRef.current;
      if (reportMode) {
        const hit = map.queryRenderedFeatures(e.point, { layers: [BUILDING_LAYER] })[0];
        if (!hit) return;
        // Pick the footprint under the cursor (or the closest one) out of the merged feature.
        const parts = polygons(hit.geometry);
        const { lng, lat } = e.lngLat;
        const part =
          parts.find((p) => pointInPolygon(lng, lat, p)) ??
          parts.reduce<Polygon | null>(
            (best, p) => (!best || distanceToPolygon(p, lng, lat) < distanceToPolygon(best, lng, lat) ? p : best),
            null,
          );
        if (!part) return;
        const [longitude, latitude] = interiorPoint(part, [lng, lat]);
        const h = Number(hit.properties.render_height);
        onReportBuilding({ longitude, latitude, height: Number.isFinite(h) ? h : null });
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, {
        layers: ["incidents-dot", "incidents-label", INCIDENT_BUILDING_LAYER],
      })[0];
      if (hit) onSelect(String(hit.properties.id ?? hit.properties.incidentId));
    });

    for (const layer of [BUILDING_LAYER, INCIDENT_BUILDING_LAYER, "incidents-dot"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = propsRef.current.reportMode ? "crosshair" : "";
      });
    }

    // Detail panels and responsive layouts resize the map without a window resize.
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container.current);

    return () => {
      resizeObserver.disconnect();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !props.flood) return;
    (map.getSource("flood") as GeoJSONSource).setData(props.flood.geojson);
  }, [props.flood]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("incidents") as GeoJSONSource).setData(incidentPoints(props.state, props.selectedId));
    (map.getSource("teams") as GeoJSONSource).setData(teamPoints(props.state));
    syncBuildings.current();
  }, [props.state, props.selectedId]);

  // Centre on the selected incident.
  useEffect(() => {
    const map = mapRef.current;
    const incident = props.state.incidents.find((i) => i.id === props.selectedId);
    if (!map || incident?.latitude == null || incident.longitude == null) return;
    map.easeTo({ center: [incident.longitude, incident.latitude], zoom: Math.max(map.getZoom(), 16.2), duration: 900 });
    // Only when the selection changes, not on every incident update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId]);

  useEffect(() => {
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = props.reportMode ? "crosshair" : "";
  }, [props.reportMode]);

  // MapLibre's CSS forces `position: relative` on the map element, so size it from a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
