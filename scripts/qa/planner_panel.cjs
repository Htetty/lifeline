/* Independent component logic QA. Actual AssignmentPlanner component, in-memory
 * React hook harness and mocked store; NOT browser, map, provider or human evidence.
 * No production files are emitted or changed. Uses already-installed dependencies.
 * Run: node scripts/qa/planner_panel.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire, Module } = require("node:module");
const root = path.resolve(__dirname, "../..");
const dependencies = createRequire(path.join(root, "dashboard/node_modules/__qa__.cjs"));
const ts = dependencies("typescript");
let values = [], cursor = 0;
const store = {
  recordProposal: async () => ({ matched: true }),
  approvePlan: async () => { throw new Error("QA must not approve or contact a service"); },
  errorMessage: (e) => String(e),
};
const hooks = {
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useState(initial) {
    const k = cursor++;
    if (!(k in values)) values[k] = initial;
    return [values[k], (next) => { values[k] = typeof next === "function" ? next(values[k]) : next; }];
  },
};
const cache = new Map();
function load(filename) {
  filename = [filename, `${filename}.ts`, `${filename}.tsx`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!filename) throw new Error("Missing QA module");
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename); cache.set(filename, mod); mod.filename = filename;
  mod.require = (name) => {
    if (name === "react") return hooks;
    if (name === "@/lib/store") return store;
    if (name.startsWith("@/")) return load(path.join(root, "dashboard/src", name.slice(2)));
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), name));
    return dependencies(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return mod.exports;
}
const { AssignmentPlanner } = load(path.join(root, "dashboard/src/components/AssignmentPlanner.tsx"));
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...nodes(node.props.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" ? text(node.props?.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function fixture() {
  values = []; cursor = 0;
  const i = { id: "fictional", exerciseId: "fictional", callId: null, source: "fixture", reportedAddress: "1 Fictional Way",
    latitude: 32.76, longitude: -117.17, locationVerified: true, peopleCount: 2, reportedPosition: "roof", hazards: [], summary: "Simulated",
    transcript: null, status: "awaiting_assignment", assignedTeamId: null, callConnected: false, createdAt: 1, updatedAt: 1, version: 1 };
  const team = { id: "truck", name: "Fictional Truck", latitude: 32.75, longitude: -117.17, capabilities: ["road_vehicle"],
    available: true, currentAssignment: null, trip: null, updatedAt: 0, simulated: true };
  const props = { state: { waterSurfaceElevation: 9, waterObservedAt: null, incidents: [i], teams: [team] },
    priorities: new Map([[i.id, { tier: "standard", reasons: [] }]]), notReady: null,
    routeFor: () => ({ ok: true, mover: "road_vehicle", realSeconds: 600, path: [[-117.17, 32.75], [-117.17, 32.755], [-117.17, 32.76]],
      legs: [{ mode: "road", end: 2 }], maxDepth: 0, limit: 0.3, metres: { road: 1100, foot: 0, water: 0, air: 0 } }),
    onPreview() {}, onSelectIncident() {}, onDone() {}, onClose() {} };
  const render = () => { cursor = 0; return AssignmentPlanner(props); };
  const button = (label) => nodes(render()).find((n) => n.type === "button" && text(n).includes(label));
  const suggest = async () => { button("Suggest assignments").props.onClick(); await Promise.resolve(); await Promise.resolve(); };
  return { props, render, button, suggest };
}
const cases = [
  ["headcount change disables approval of the old capacity warning", async () => {
    const f = fixture(); await f.suggest();
    assert.equal(f.button("Approve 1 selected").props.disabled, false);
    f.props.state = { ...f.props.state, incidents: [{ ...f.props.state.incidents[0], peopleCount: 40 }] };
    assert.equal(f.button("Approve 1 selected").props.disabled, true);
  }],
  ["client-side computed priority change disables the old plan", async () => {
    const f = fixture(); await f.suggest();
    f.props.priorities = new Map([["fictional", { tier: "critical", reasons: ["water model: building fully submerged"] }]]);
    assert.equal(f.button("Approve 1 selected").props.disabled, true);
  }],
  ["pending river change disables approval until the model has saved", async () => {
    const f = fixture(); await f.suggest();
    f.props.notReady = "Wait for the river level change to save, then suggest.";
    assert.equal(f.button("Approve 1 selected").props.disabled, true);
  }],
];
(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.log(`FAIL ${name}\n${error.message}`); }
  }
  console.log(`Component logic only: ${cases.length - failures} passed, ${failures} failed. No browser/audio/service verification.`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
