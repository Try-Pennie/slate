import { shapePrecomputedRow } from "../src/lib/availability/precompute-shape.ts";
import { assert, finish } from "./lib/harness.ts";

// A well-formed stored row reshapes back into the exact BucketSlots payload.
const payload = {
  bucket: { code: "411", name: "Senior Loan Advisor Call" },
  eventType: { name: "Call", description: null, duration_min: 20, min_notice_min: 0 },
  orgName: "Pennie",
  slots: ["2026-06-18T16:30:00.000Z", "2026-06-18T17:00:00.000Z"],
};
const ok = shapePrecomputedRow({ payload });
assert(ok !== null, "well-formed row returns a BucketSlots");
assert(ok?.bucket.code === "411", "bucket round-trips");
assert(ok?.orgName === "Pennie", "orgName round-trips");
assert(JSON.stringify(ok?.slots) === JSON.stringify(payload.slots), "slots round-trip");
assert((ok?.eventType as { duration_min: number }).duration_min === 20, "eventType round-trips");

// A missing row (no precomputed entry) is a miss, not a crash.
assert(shapePrecomputedRow(null) === null, "null row -> null (miss)");

// A malformed row (lost a required key, or slots not an array) is treated as a
// miss so the route falls back instead of serving a broken/garbage payload.
assert(shapePrecomputedRow({ payload: { bucket: { code: "x" } } }) === null,
  "row missing eventType/orgName/slots -> null");
assert(shapePrecomputedRow({ payload: { ...payload, slots: "nope" } }) === null,
  "row with non-array slots -> null");

finish();
