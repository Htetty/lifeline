// Downloads the drivable OpenStreetMap roads in the flood area and writes
// public/data/roads.json for the flood-aware router (src/lib/router.ts).
// Run from dashboard/: `node scripts/fetch-roads.mjs`. Road data © OpenStreetMap contributors.

import { mkdirSync, writeFileSync } from "node:fs";

// Same as DEMO_AREA.floodBounds in src/data/fixtures.ts.
const BOUNDS = { west: -117.185, south: 32.752, east: -117.135, north: 32.776 };
const CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
  "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
];
// Flags stored per edge.
const ONEWAY = 1;
const BRIDGE = 2;
const TUNNEL = 4;

const { west, south, east, north } = BOUNDS;
const query = `[out:json][timeout:90];
way["highway"~"^(${CLASSES.join("|")})$"](${south},${west},${north},${east});
(._;>;);
out body qt;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "hurricaneai-flood-demo/0.1" },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
const { elements } = await res.json();

// Sort so the output (and node numbering) is the same on every run.
const osmNodes = new Map(elements.filter((e) => e.type === "node").map((n) => [n.id, n]));
const ways = elements.filter((e) => e.type === "way").sort((a, b) => a.id - b.id);

const index = new Map();
const nodes = [];
function nodeIndex(id) {
  if (!index.has(id)) {
    const n = osmNodes.get(id);
    index.set(id, nodes.length / 2);
    nodes.push(Number(n.lon.toFixed(6)), Number(n.lat.toFixed(6)));
  }
  return index.get(id);
}

const edges = [];
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

mkdirSync(new URL("../public/data/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../public/data/roads.json", import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL)", bounds: BOUNDS, classes: CLASSES, nodes, edges }),
);
console.log(`Wrote ${nodes.length / 2} nodes, ${edges.length} edges from ${ways.length} roads`);
