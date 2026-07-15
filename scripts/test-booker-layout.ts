import { normalizeBookerLayout } from "../src/lib/booking/layout.ts";
import { assert, finish } from "./lib/harness.ts";
assert(normalizeBookerLayout("month") === "month", "'month' stays month");
assert(normalizeBookerLayout("strip") === "strip", "'strip' stays strip");
assert(normalizeBookerLayout(null) === "strip", "null -> strip (default)");
assert(normalizeBookerLayout(undefined) === "strip", "undefined -> strip");
assert(normalizeBookerLayout("garbage") === "strip", "unknown -> strip");
finish();
