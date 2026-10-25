"use client";

import { useEffect, useRef } from "react";
import { Map as MLMap, Marker, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { REGIONS } from "../../convex/regions";
import type { FloodResult } from "@/lib/flood";
import { distanceToPolygon, expandPolygon, interiorPoint, pointInPolygon, polygons } from "@/lib/geo";
import type { ExerciseState, Incident } from "@/lib/types";
import { ACTIVE_STATUSES, DISPATCHED_STATUSES } from "@/lib/types";
import { ROUTE_COLOR } from "@/lib/router";
import { OBSERVATION_RADIUS_M } from "@/lib/flood";
import { etaMinutes, remainingLegs, vehiclePosition, type LegMode, type TripLeg } from "../../convex/tripMath";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const BUILDING_SOURCE = { source: "openmaptiles", sourceLayer: "building" } as const;
const BUILDING_LAYER = "building-3d";
const INCIDENT_BUILDING_LAYER = "incident-buildings";
const SNAP_DISTANCE_M = 25;
/** How often the remaining-route lines are trimmed; moving teams themselves move every animation frame. */
const ROUTE_FRAME_MS = 250;

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

const ROUTE_COLOR_EXPRESSION = [
  "match", ["get", "mode"],
  "water", ROUTE_COLOR.water,
  "foot", ROUTE_COLOR.foot,
  ROUTE_COLOR.road,
] as unknown as string;

interface Props {
  state: ExerciseState;
  flood: FloodResult | null;
  /** Proposed route for the selected incident, before a team sets off. */
  preview: { path: number[][]; legs: TripLeg[] } | null;
  /** Callers' water reports and the area each one corrects. */
  callerZones: { lon: number; lat: number; label: string }[];
  /** Team to show and follow; `key` changes on every click so the same team can be re-centred. */
  focusTeam: { id: string; key: number } | null;
  onFocusTeam: (teamId: string | null) => void;
  selectedId: string | null;
  /** Pixels of map hidden under the incident sheet (right, bottom), so a selected incident is centred in what stays visible. */
  coveredBy?: () => [number, number];
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

function teamPosition(team: ExerciseState["teams"][number], now: number) {
  return team.trip ? vehiclePosition(team.trip, now) : [team.longitude, team.latitude];
}

function teamPoints(state: ExerciseState, now: number, focusedId: string | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: state.teams.map((t) => {
      const moving = t.trip != null && now < t.trip.arriveAt;
      const position = teamPosition(t, now);
      const eta = moving ? etaMinutes(t.trip!, now) : 0;
      return {
        type: "Feature",
        properties: {
          name: moving ? `${t.name} · ETA ${eta} min` : `${t.name}${t.available ? "" : " (busy)"}`,
          id: t.id,
          available: t.available,
          moving,
          focused: t.id === focusedId,
        },
        geometry: { type: "Point", coordinates: position },
      };
    }),
  };
}

function legLines(legs: { mode: LegMode; coords: number[][] }[]): GeoJSON.Feature[] {
  return legs.map((l) => ({
    type: "Feature",
    properties: { mode: l.mode },
    geometry: { type: "LineString", coordinates: l.coords },
  }));
}

function teamRoutes(state: ExerciseState, now: number): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: state.teams.filter((t) => t.trip && now < t.trip.arriveAt).flatMap((t) => legLines(remainingLegs(t.trip!, now))),
  };
}

function previewRoute(preview: Props["preview"]): GeoJSON.FeatureCollection {
  if (!preview) return { type: "FeatureCollection", features: [] };
  let start = 0;
  const legs = preview.legs.map((l) => {
    const coords = preview.path.slice(start, l.end + 1);
    start = l.end;
    return { mode: l.mode, coords };
  });
  return { type: "FeatureCollection", features: legLines(legs) };
}

function drawTeams(map: MLMap, props: Props) {
  const now = Date.now();
  (map.getSource("teams") as GeoJSONSource).setData(teamPoints(props.state, now, props.focusTeam?.id ?? null));
  (map.getSource("team-routes") as GeoJSONSource).setData(teamRoutes(props.state, now));
}

/**
 * Teams on the move are DOM markers placed every animation frame: a GeoJSON source
 * updates through MapLibre's worker, which can't keep up at 60 fps. The followed team's
 * camera moves in the same frame, so the view glides with it.
 */
function moveMarkers(map: MLMap, props: Props, markers: Map<string, Marker>, follow: string | null, onFocus: (id: string) => void) {
  const now = Date.now();
  const moving = props.state.teams.filter((t) => t.trip && now < t.trip.arriveAt);
  for (const [id, marker] of markers) {
    if (!moving.some((t) => t.id === id)) {
      marker.remove();
      markers.delete(id);
    }
  }
  for (const team of moving) {
    let marker = markers.get(team.id);
    if (!marker) {
      const el = document.createElement("button");
      el.className = "team-mover";
      el.title = "Follow on map";
      el.append(Object.assign(document.createElement("span"), { className: "team-mover-dot" }));
      el.append(Object.assign(document.createElement("span"), { className: "team-mover-label" }));
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onFocus(team.id);
      });
      marker = new Marker({ element: el }).setLngLat(teamPosition(team, now) as [number, number]).addTo(map);
      markers.set(team.id, marker);
    }
    const position = teamPosition(team, now) as [number, number];
    marker.setLngLat(position);
    const el = marker.getElement();
    const label = `${team.name} · ETA ${etaMinutes(team.trip!, now)} min`;
    const text = el.lastElementChild!;
    if (text.textContent !== label) text.textContent = label;
    el.classList.toggle("is-focused", team.id === (props.focusTeam?.id ?? null));
    // Keep a followed team in view, without fighting a camera move already under way.
    if (team.id === follow && !map.isMoving()) map.jumpTo({ center: position });
  }
}

/** A ring around each caller's water report, with a label at its northern edge. */
function callerZoneShapes(zones: Props["callerZones"]): GeoJSON.FeatureCollection {
  const metresPerDegLat = 111_320;
  return {
    type: "FeatureCollection",
    features: zones.flatMap((z) => {
      const dLat = OBSERVATION_RADIUS_M / metresPerDegLat;
      const dLon = OBSERVATION_RADIUS_M / (metresPerDegLat * Math.cos((z.lat * Math.PI) / 180));
      const ring = Array.from({ length: 65 }, (_, k) => {
        const a = (k / 64) * 2 * Math.PI;
        return [z.lon + dLon * Math.cos(a), z.lat + dLat * Math.sin(a)];
      });
      return [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } },
        { type: "Feature", properties: { label: z.label }, geometry: { type: "Point", coordinates: [z.lon, z.lat + dLat] } },
      ] as GeoJSON.Feature[];
    }),
  };
}

export default function FloodMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  const lastResolved = useRef("");
  /** Team the camera follows while it moves. */
  const followRef = useRef<string | null>(null);

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
    const view = REGIONS[propsRef.current.state.region].view;
    const map = new MLMap({
      container: container.current,
      style: STYLE_URL,
      center: view.center,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
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

    // MapLibre opens the compact attribution on first load; start it folded behind its (i) button.
    map.once("idle", () => {
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    map.on("load", () => {
      // Recolor the existing basemap, preserving its tiles, buildings and overlays.
      for (const layer of map.getStyle().layers) {
        const name = layer.id.toLowerCase();
        if (layer.type === "background") {
          map.setPaintProperty(layer.id, "background-color", "#0f1113");
        } else if (layer.type === "fill") {
          map.setPaintProperty(layer.id, "fill-color",
            /water/.test(name) ? "#13202b" : /park|wood|grass|landcover/.test(name) ? "#121815" : "#121416");
        } else if (layer.type === "line") {
          map.setPaintProperty(layer.id, "line-color",
            /water/.test(name) ? "#22394a" : /boundary/.test(name) ? "#3a3f47" : /casing/.test(name) ? "#16181b" : "#3c4149");
        } else if (layer.type === "symbol" && layer.layout?.["text-field"]) {
          map.setPaintProperty(layer.id, "text-color", /place|city|town/.test(name) ? "#b9bec6" : "#7d838c");
          map.setPaintProperty(layer.id, "text-halo-color", "#0f1113");
          // Basemap POI icons are full-colour; dim them so incidents and teams stand out.
          if (layer.layout?.["icon-image"]) map.setPaintProperty(layer.id, "icon-opacity", 0.4);
        } else if (layer.type === "fill-extrusion") {
          map.setPaintProperty(layer.id, "fill-extrusion-color", "#262a30");
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

      map.addSource("caller-zones", { type: "geojson", data: callerZoneShapes(propsRef.current.callerZones) });
      map.addLayer({
        id: "caller-zones-ring",
        type: "line",
        source: "caller-zones",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#e3e6ea", "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "caller-zones-label",
        type: "symbol",
        source: "caller-zones",
        filter: ["==", ["geometry-type"], "Point"],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "bottom" },
        paint: { "text-color": "#e3e6ea", "text-halo-color": "#0f1113", "text-halo-width": 1.5 },
      });
      map.addSource("route-preview", { type: "geojson", data: previewRoute(propsRef.current.preview) });
      map.addLayer({
        id: "route-preview-line",
        type: "line",
        source: "route-preview",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_COLOR_EXPRESSION, "line-width": 5, "line-opacity": 0.75, "line-dasharray": [1.2, 1] },
      });
      map.addSource("team-routes", { type: "geojson", data: teamRoutes(propsRef.current.state, Date.now()) });
      // Road and water legs are solid; walking and flying are dashed.
      map.addLayer({
        id: "team-routes-solid",
        type: "line",
        source: "team-routes",
        filter: ["in", ["get", "mode"], ["literal", ["road", "water"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_COLOR_EXPRESSION, "line-width": 4, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "team-routes-dashed",
        type: "line",
        source: "team-routes",
        filter: ["in", ["get", "mode"], ["literal", ["foot", "air"]]],
        layout: { "line-join": "round" },
        paint: { "line-color": ROUTE_COLOR_EXPRESSION, "line-width": 3, "line-opacity": 0.9, "line-dasharray": [1, 1.5] },
      });
      map.addSource("teams", {
        type: "geojson",
        data: teamPoints(propsRef.current.state, Date.now(), propsRef.current.focusTeam?.id ?? null),
      });
      map.addLayer({
        id: "teams-dot",
        type: "circle",
        source: "teams",
        filter: ["!", ["get", "moving"]],
        paint: {
          "circle-radius": ["case", ["get", "focused"], 12, ["get", "moving"], 9, 7],
          "circle-color": ["case", ["get", "moving"], "#f59e0b", ["get", "available"], "#2563eb", "#64748b"],
          "circle-stroke-color": ["case", ["get", "focused"], "#8fc2ff", "#0f1113"],
          "circle-stroke-width": ["case", ["get", "focused"], 4, 2],
        },
      });
      map.addLayer({
        id: "teams-label",
        type: "symbol",
        source: "teams",
        filter: ["!", ["get", "moving"]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: { "text-color": "#bcd6ff", "text-halo-color": "#0f1113", "text-halo-width": 1.5 },
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
          "circle-stroke-color": ["case", ["get", "verified"], "#fff", "#0f1113"],
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
        paint: { "text-color": "#ffd0d0", "text-halo-color": "#0f1113", "text-halo-width": 2 },
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
      const team = map.queryRenderedFeatures(e.point, { layers: ["teams-dot", "teams-label"] })[0];
      if (team) {
        propsRef.current.onFocusTeam(String(team.properties.id));
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, {
        layers: ["incidents-dot", "incidents-label", INCIDENT_BUILDING_LAYER],
      })[0];
      if (hit) onSelect(String(hit.properties.id ?? hit.properties.incidentId));
    });
    // Dragging the map stops following a team.
    map.on("dragstart", () => {
      if (followRef.current) propsRef.current.onFocusTeam(null);
    });

    for (const layer of [BUILDING_LAYER, INCIDENT_BUILDING_LAYER, "incidents-dot", "teams-dot"]) {
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
    if (!map || !readyRef.current) return;
    // Cleared while another region's flood is still loading.
    (map.getSource("flood") as GeoJSONSource).setData(props.flood?.geojson ?? { type: "FeatureCollection", features: [] });
  }, [props.flood]);

  // The exercise moved to another region: fly there.
  const region = props.state.region;
  const shownRegion = useRef(region);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || shownRegion.current === region) return;
    shownRegion.current = region;
    const { center, zoom, pitch, bearing } = REGIONS[region].view;
    map.flyTo({ center, zoom, pitch, bearing, duration: 1800 });
  }, [region]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("incidents") as GeoJSONSource).setData(incidentPoints(props.state, props.selectedId));
    drawTeams(map, propsRef.current);
    syncBuildings.current();
  }, [props.state, props.selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("route-preview") as GeoJSONSource).setData(previewRoute(props.preview));
  }, [props.preview]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("caller-zones") as GeoJSONSource).setData(callerZoneShapes(props.callerZones));
  }, [props.callerZones]);

  // Fly to a team when it is picked, then keep it in view while it moves.
  const focus = props.focusTeam;
  useEffect(() => {
    const map = mapRef.current;
    followRef.current = focus?.id ?? null;
    if (!map || !focus) return;
    const team = propsRef.current.state.teams.find((t) => t.id === focus.id);
    if (!team) return;
    map.flyTo({
      center: teamPosition(team, Date.now()) as [number, number],
      zoom: Math.max(map.getZoom(), 16),
      duration: 900,
    });
    if (readyRef.current) drawTeams(map, propsRef.current);
  }, [focus]);

  // While any trip is under way, moving teams glide every animation frame and the route lines shorten.
  const anyTrip = props.state.teams.some((t) => t.trip);
  const markersRef = useRef(new Map<string, Marker>());
  useEffect(() => {
    if (!anyTrip) return;
    const markers = markersRef.current;
    let frame = 0;
    let lastRoutes = 0;
    const tick = (time: number) => {
      const map = mapRef.current;
      if (map && readyRef.current) {
        const focus = (id: string) => propsRef.current.onFocusTeam(id);
        moveMarkers(map, propsRef.current, markers, followRef.current, focus);
        if (time - lastRoutes >= ROUTE_FRAME_MS) {
          lastRoutes = time;
          drawTeams(map, propsRef.current);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      const map = mapRef.current;
      if (map && readyRef.current) drawTeams(map, propsRef.current);
    };
  }, [anyTrip]);

  // Centre on the selected incident.
  useEffect(() => {
    const map = mapRef.current;
    const incident = props.state.incidents.find((i) => i.id === props.selectedId);
    if (!map || incident?.latitude == null || incident.longitude == null) return;
    const [right, bottom] = propsRef.current.coveredBy?.() ?? [0, 0];
    map.easeTo({
      center: [incident.longitude, incident.latitude],
      zoom: Math.max(map.getZoom(), 16.2),
      offset: [-right / 2, -bottom / 2],
      duration: 900,
    });
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
