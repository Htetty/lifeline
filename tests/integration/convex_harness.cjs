/* Run the real Convex handlers against disposable, process-local data.
 * No deployment URL, Convex client, network, reset, or purge operation is used.
 * This is NOT a Convex runtime: argument validators, auth enforcement by the
 * platform, OCC/concurrency, subscriptions, and deployed indexes are not tested.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createRequire, Module } = require("node:module");

const root = path.resolve(__dirname, "../..");
const dependencies = path.resolve(
  process.env.LIFELINE_DASHBOARD_NODE_MODULES || path.join(root, "dashboard/node_modules"),
);
const dependencyRequire = createRequire(path.join(dependencies, "__demo__.cjs"));
const ts = dependencyRequire("typescript");
process.env.BACKEND_SECRET = "isolated-demo-secret";
globalThis.fetch = async () => { throw new Error("Network forbidden in isolated handler tests"); };

// Transpile copies in memory, including the generated ESM utilities. Never emit
// into dashboard/ or replace its real module loader globally.
const cache = new Map();
function load(filename) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename);
  cache.set(filename, mod);
  mod.filename = filename;
  mod.require = (name) => {
    if (!name.startsWith(".")) return dependencyRequire(name);
    const base = path.resolve(path.dirname(filename), name);
    const resolved = [base, `${base}.ts`, `${base}.js`].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (!resolved || !resolved.startsWith(path.join(root, "dashboard/convex/"))) {
      throw new Error(`Unsupported local import: ${name}`);
    }
    return load(resolved);
  };
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  mod._compile(output.outputText, filename);
  return mod.exports;
}

const handlers = Object.fromEntries(["calls", "incidents", "exercise"].map(
  (name) => [name, load(path.join(root, `dashboard/convex/${name}.ts`))],
));
const { EXERCISE_ID } = load(path.join(root, "dashboard/convex/seedData.ts"));
const rows = new Map();
let counter = 0;
const clone = (value) => structuredClone(value);
const db = {
  async insert(table, value) {
    const id = `${table}:${++counter}`;
    rows.set(id, { ...clone(value), _id: id, _creationTime: counter });
    return id;
  },
  async get(id) { return rows.has(id) ? clone(rows.get(id)) : null; },
  async patch(id, value) {
    if (!rows.has(id)) throw new Error(`Missing document ${id}`);
    rows.set(id, { ...rows.get(id), ...clone(value) });
  },
  query(table) {
    const filters = [];
    let descending = false;
    const read = () => [...rows.values()]
      .filter((row) => row._id.startsWith(`${table}:`) && filters.every(([k, v]) => row[k] === v))
      .sort((a, b) => (descending ? -1 : 1) * (a._creationTime - b._creationTime))
      .map(clone);
    const query = {
      withIndex(_name, configure) {
        const index = { eq(key, value) { filters.push([key, value]); return index; } };
        configure(index);
        return query;
      },
      order(direction) { descending = direction === "desc"; return query; },
      async collect() { return read(); },
      async first() { return read()[0] ?? null; },
      async unique() {
        const result = read();
        if (result.length > 1) throw new Error("Expected a unique document");
        return result[0] ?? null;
      },
      async take(count) { return read().slice(0, count); },
    };
    return query;
  },
};

const allowed = new Set([
  "calls:upsertFromCall", "calls:callEnded", "calls:statusForCall",
  "calls:transcriptForCall", "calls:pendingEvents", "calls:markAnnounced",
  "incidents:verifyLocation", "incidents:assignTeam", "incidents:setStatus", "exercise:get",
]);

async function main() {
  await db.insert("exercises", { exerciseId: EXERCISE_ID, name: "Fictional isolated demo", waterSurfaceElevation: 14 });
  for (let number = 1; number <= 2; number++) {
    await db.insert("teams", {
      exerciseId: EXERCISE_ID, name: `Simulated Boat ${number}`, latitude: 32.76,
      longitude: -117.17, capabilities: ["boat"], available: true,
      currentAssignment: null, simulated: true, updatedAt: 1,
    });
  }
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    const before = clone(rows);
    try {
      const request = JSON.parse(line);
      if (!allowed.has(request.name)) throw new Error("Handler not allowed by isolated harness");
      const [moduleName, name] = request.name.split(":");
      const value = await handlers[moduleName][name]._handler(
        { db, auth: { getUserIdentity: async () => null } }, request.args,
      );
      process.stdout.write(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
    } catch (error) {
      // Roll back failed calls in memory. This does not simulate OCC races.
      rows.clear();
      for (const [id, row] of before) rows.set(id, row);
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.data ?? error.message })}\n`);
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
