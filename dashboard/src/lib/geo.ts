type Ring = number[][];

function pointInRing(lon: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(lon: number, lat: number, rings: Ring[]) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(lon, lat, rings[k])) return false;
  return true;
}

/** The individual polygons of a (Multi)Polygon. Building tiles merge many footprints into one feature. */
export function polygons(geometry: GeoJSON.Geometry): Ring[][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export function geometryContains(geometry: GeoJSON.Geometry, lon: number, lat: number) {
  return polygons(geometry).some((p) => pointInPolygon(lon, lat, p));
}

/** Approximate distance in metres from a point to the nearest vertex of a polygon. */
export function distanceToPolygon(polygon: Ring[], lon: number, lat: number) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const [x, y] of polygon[0]) {
    const d = Math.hypot((x - lon) * kx, (y - lat) * 111_320);
    if (d < best) best = d;
  }
  return best;
}

function centroid(ring: Ring): [number, number] {
  const n = ring.length;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

/** A point inside the polygon: its vertex centroid when that falls inside, else the fallback. */
export function interiorPoint(polygon: Ring[], fallback: [number, number]): [number, number] {
  const [lon, lat] = centroid(polygon[0]);
  return pointInPolygon(lon, lat, polygon) ? [lon, lat] : fallback;
}

/** Grow a polygon outward by roughly `meters`, so an overlay doesn't z-fight the original walls. */
export function expandPolygon(polygon: Ring[], meters: number): Ring[] {
  const [cx, cy] = centroid(polygon[0]);
  const kx = 111_320 * Math.cos((cy * Math.PI) / 180);
  const radius = Math.max(...polygon[0].map(([x, y]) => Math.hypot((x - cx) * kx, (y - cy) * 111_320)), 1);
  const f = 1 + meters / radius;
  return polygon.map((ring) => ring.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]));
}
