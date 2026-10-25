// Runs a TypeScript script with the dashboard's "@/" import alias:
//   node scripts/run.mjs scripts/sim/build-scenario.ts [args…]
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } });
const [script, ...args] = process.argv.slice(2);
process.argv = [process.argv[0], script, ...args];
await jiti.import(pathToFileURL(resolve(script)).href);
