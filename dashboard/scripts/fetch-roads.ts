// Downloads the drivable OpenStreetMap roads in a region's area and writes
// public/data/<region>/roads.json for the flood-aware router (src/lib/router.ts).
// Run from dashboard/: `npm run fetch:roads -- --region sf-waterfront`. Road data © OpenStreetMap contributors.

import { mkdirSync, writeFileSync } from "node:fs";
import { overpass } from "./overpass";
import { regionArg } from "./regionArg";

const region = regionArg();
const BOUNDS = region.bounds;
const CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
  "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
];
// Flags stored per edge.
const ONEWAY = 1;
const BRIDGE = 2;
const TUNNEL = 4;

interface OsmElement {
  type: "node" | "way";
  id: number;
  lon: number;
  lat: number;
  nodes: number[];
  tags: Record<string, string>;
}

const { west, south, east, north } = BOUNDS;
const query = `[out:json][timeout:90];
way["highway"~"^(${CLASSES.join("|")})$"](${south},${west},${north},${east});
(._;>;);
out body qt;`;

const elements = await overpass<OsmElement>(query);

// Sort so the output (and node numbering) is the same on every run.
const osmNodes = new Map(elements.filter((e) => e.type === "node").map((n) => [n.id, n]));
const ways = elements.filter((e) => e.type === "way").sort((a, b) => a.id - b.id);

const index = new Map<number, number>();
const nodes: number[] = [];
function nodeIndex(id: number) {
  if (!index.has(id)) {
    const n = osmNodes.get(id)!;
    index.set(id, nodes.length / 2);
    nodes.push(Number(n.lon.toFixed(6)), Number(n.lat.toFixed(6)));
  }
  return index.get(id)!;
}

const edges: [number, number, number, number][] = [];
for (const way of ways) {
  const t = way.tags;
  const cls = CLASSES.indexOf(t.highway);
  const reversed = t.oneway === "-1";
  const oneway = reversed || t.oneway === "yes" || t.highway === "motorway" || t.junction === "roundabout";
  const flags = (oneway ? ONEWAY : 0) | (t.bridge && t.bridge !== "no" ? BRIDGE : 0) | (t.tunnel && t.tunnel !== "no" ? TUNNEL : 0);
  const refs = reversed ? [...way.nodes].reverse() : way.nodes;
  for (let i = 1; i < refs.length; i++) {
    if (!osmNodes.has(refs[i - 1]) || !osmNodes.has(refs[i])) continue;
    edges.push([nodeIndex(refs[i - 1]), nodeIndex(refs[i]), cls, flags]);
  }
}

mkdirSync(new URL(`../public/data/${region.id}/`, import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../public/data/${region.id}/roads.json`, import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL)", bounds: BOUNDS, classes: CLASSES, nodes, edges }),
);
console.log(`Wrote ${nodes.length / 2} nodes, ${edges.length} edges from ${ways.length} roads`);
