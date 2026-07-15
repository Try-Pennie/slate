import { pruneCutoffIso } from "../src/lib/routing/retention.ts";
import { assert, finish } from "./lib/harness.ts";

assert(pruneCutoffIso("2026-06-26T00:00:00.000Z") === "2025-06-26T00:00:00.000Z", "12 months back");
assert(pruneCutoffIso("2026-06-26T00:00:00.000Z", 6) === "2025-12-26T00:00:00.000Z", "6 months back");

finish();
