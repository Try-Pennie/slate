// Size caps for the public booking input schemas (#1034). Both booking entry
// points (the embed /booking route and the direct /api/bookings parser) compose
// from these shared, bounded field schemas so an unbounded string or prefill
// blob can't flow into Postgres / gcal event bodies / webhook payloads. Pure, so
// it runs under `node --experimental-strip-types`.
// Run: node --experimental-strip-types scripts/test-input-limits.ts
import type { z } from "zod";
import { INPUT_LIMITS } from "../src/lib/booking/input-limits.ts";
import {
  bucketCodeSchema,
  startSchema,
  timezoneSchema,
  salesforceIdSchema,
  prefillSchema,
} from "../src/lib/booking/input-schema.ts";
import { assert, finish } from "./lib/harness.ts";

// --- the caps themselves are the spec'd values ---
assert(INPUT_LIMITS.contact === 200, "contact (name/email/phone) cap is 200");
assert(INPUT_LIMITS.code === 64, "bucketCode/timezone cap is 64");
assert(INPUT_LIMITS.prefillKeys === 20, "prefill key-count cap is 20");
assert(INPUT_LIMITS.prefillValue === 500, "prefill per-value cap is 500");

const accepts = (s: z.ZodTypeAny, v: unknown) => s.safeParse(v).success;

// --- bucketCode / timezone: non-empty, trimmed, bounded at the code cap ---
assert(accepts(bucketCodeSchema, "411"), "bucketCode within cap accepted");
assert(accepts(bucketCodeSchema, "a".repeat(INPUT_LIMITS.code)), "bucketCode exactly at cap accepted");
assert(!accepts(bucketCodeSchema, "a".repeat(INPUT_LIMITS.code + 1)), "bucketCode over cap rejected");
assert(!accepts(bucketCodeSchema, ""), "empty bucketCode rejected");
assert(!accepts(bucketCodeSchema, "   "), "whitespace-only bucketCode rejected");
assert(!accepts(timezoneSchema, "a".repeat(INPUT_LIMITS.code + 1)), "timezone over cap rejected");

// --- start: bounded (an ISO instant is short; a blob is not a time) ---
assert(accepts(startSchema, "2026-07-01T15:00:00Z"), "ISO start within cap accepted");
assert(!accepts(startSchema, "a".repeat(INPUT_LIMITS.start + 1)), "start over cap rejected");

// --- salesforceId: bounded (nullability is applied at the call site) ---
assert(accepts(salesforceIdSchema, "00Q5x000001abcEAA"), "salesforceId within cap accepted");
assert(!accepts(salesforceIdSchema, "a".repeat(INPUT_LIMITS.salesforceId + 1)), "salesforceId over cap rejected");

// --- prefill: defaults to {}, bounded per key, per value, and by key count ---
assert(prefillSchema.safeParse(undefined).success, "omitted prefill is allowed");
assert(JSON.stringify(prefillSchema.parse(undefined)) === "{}", "omitted prefill defaults to {}");
assert(accepts(prefillSchema, { utm_source: "regal" }), "a small prefill is accepted");
assert(!accepts(prefillSchema, { k: "v".repeat(INPUT_LIMITS.prefillValue + 1) }), "prefill value over 500 chars rejected");
assert(accepts(prefillSchema, { k: "v".repeat(INPUT_LIMITS.prefillValue) }), "prefill value exactly 500 chars accepted");
assert(!accepts(prefillSchema, { ["k".repeat(INPUT_LIMITS.prefillKey + 1)]: "v" }), "prefill key over its cap rejected");

const overKeyCount = Object.fromEntries(
  Array.from({ length: INPUT_LIMITS.prefillKeys + 1 }, (_, i) => [`k${i}`, "v"]),
);
assert(!accepts(prefillSchema, overKeyCount), "prefill with more than 20 keys rejected");
const atKeyCount = Object.fromEntries(
  Array.from({ length: INPUT_LIMITS.prefillKeys }, (_, i) => [`k${i}`, "v"]),
);
assert(accepts(prefillSchema, atKeyCount), "prefill with exactly 20 keys accepted");
assert(!accepts(prefillSchema, { n: 5 }), "non-string prefill value still rejected");

finish();
