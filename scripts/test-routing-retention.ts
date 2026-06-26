import { pruneCutoffIso } from "../src/lib/routing/retention.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else console.log("ok:", msg);
}

assert(pruneCutoffIso("2026-06-26T00:00:00.000Z") === "2025-06-26T00:00:00.000Z", "12 months back");
assert(pruneCutoffIso("2026-06-26T00:00:00.000Z", 6) === "2025-12-26T00:00:00.000Z", "6 months back");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
