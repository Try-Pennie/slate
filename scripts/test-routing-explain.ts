import { classifyExclusions } from "../src/lib/routing/explain.ts";
import type { Attributes } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

const agents: { id: string; attributes: Attributes }[] = [
  { id: "uh1", attributes: { debt_team: "ultra_high" } }, // matches, free
  { id: "uh2", attributes: { debt_team: "ultra_high" } }, // matches, NOT free
  { id: "vh1", attributes: { debt_team: "very_high" } },  // criteria miss
  { id: "man", attributes: { debt_team: "low" } },        // manual member, free
];
const criteria = { debt_team: "ultra_high" };
const manual = new Set<string>(["man"]);
const free = ["uh1", "man"];

const out = classifyExclusions(agents, manual, criteria, free);

assert(out.considered.sort().join(",") === "man,uh1", "considered = free eligible agents");
assert(
  out.excluded.some((e) => e.user_id === "uh2" && e.reason === "no_availability"),
  "eligible-but-not-free => no_availability",
);
assert(
  out.excluded.some((e) => e.user_id === "vh1" && e.reason === "criteria_miss"),
  "criteria mismatch => criteria_miss",
);
assert(!out.excluded.some((e) => e.user_id === "man"), "manual member never excluded");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
