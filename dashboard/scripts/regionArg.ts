import { DEFAULT_REGION, REGIONS, type RegionId } from "../convex/regions";

/** The region named by `--region <id>` on the command line (default: the default region). */
export function regionArg() {
  const at = process.argv.indexOf("--region");
  const id = (at > 0 ? process.argv[at + 1] : DEFAULT_REGION) as RegionId;
  const region = REGIONS[id];
  if (!region) throw new Error(`Unknown region "${id}"; one of: ${Object.keys(REGIONS).join(", ")}`);
  return region;
}
