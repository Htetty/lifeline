// Priority rule cases: npm run test:priority (compiles src/lib/priority.ts, then runs these).
const { computePriority } = require(require("path").resolve(process.argv[2], "priority.js"));
const base = { id: "x", reportedPosition: null, riskFactors: [], priorityOverride: null };
const w = (depth, h = 10, submerged = false) => ({ depth, buildingHeight: h, submerged });
const cases = [
  ["no factors, dry", { ...base }, w(0), "standard"],
  ["child", { ...base, riskFactors: [{ factor: "child" }] }, null, "high"],
  ["chest-deep water (caller)", { ...base, riskFactors: [{ factor: "water_chest_or_higher" }] }, null, "critical"],
  ["car + rising fast", { ...base, riskFactors: [{ factor: "in_vehicle" }, { factor: "water_rising_fast" }] }, null, "critical"],
  ["2nd floor, water 2.5 m (below floor)", { ...base, reportedPosition: "second floor" }, w(2.5), "high"],
  ["2nd floor, water 3.5 m (on floor)", { ...base, reportedPosition: "second floor" }, w(3.5), "high"],
  ["2nd floor, water 4.5 m (chest)", { ...base, reportedPosition: "second floor" }, w(4.5), "critical"],
  ["ground floor, water 0.7 m", { ...base, reportedPosition: "Ground floor, standing on furniture" }, w(0.7), "high"],
  ["roof of 5 m building, water 3 m", { ...base, reportedPosition: "on the roof" }, w(3, 5), "standard"],
  ["roof of 5 m building, water 4.5 m", { ...base, reportedPosition: "on the roof" }, w(4.5, 5), "high"],
  ["room 312 only, water 9 m", { ...base, reportedPosition: "room 312" }, w(9, 26), "critical"],
  ["room 312 only, water 5.5 m", { ...base, reportedPosition: "room 312" }, w(5.5, 26), "high"],
  ["room 105, water 0.3 m", { ...base, reportedPosition: "room 105" }, w(0.3, 26), "high"],
  ["number but no room word", { ...base, reportedPosition: "312 people?" }, w(9, 26), "standard"],
  ["submerged building", { ...base }, w(6, 5, true), "critical"],
  ["linked witness saw a child", { ...base }, null, "high", [{ riskFactors: [{ factor: "child" }] }]],
  ["override lowers critical", { ...base, riskFactors: [{ factor: "serious_injury" }], priorityOverride: { tier: "standard", reason: "caller confirmed injury minor" } }, null, "standard"],
];
let fail = 0;
for (const [name, inc, water, want, linked = []] of cases) {
  const p = computePriority(inc, linked, water);
  const ok = p.tier === want; if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(42)} → ${p.tier}${ok ? "" : ` (want ${want})`}  ${p.reasons.join(" · ")}`);
}
process.exit(fail ? 1 : 0);
