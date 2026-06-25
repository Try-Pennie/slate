// Webhook dedupe-key derivation (#436 / #429 P1). The key makes a re-enqueued
// webhook idempotent so a retry (or the future outbox executor) never double-
// fires Regal/Cadence. created/completed key on the booking id (exactly one of
// each per booking); the three mutation events key on the booking_events row id
// (versioned, so a legitimate SECOND reschedule is NOT deduped away); a mutation
// with no history id degrades to null = no dedup (at-least-once, never dropped).
// Run: node --experimental-strip-types scripts/test-webhook-dedupe.ts
import { webhookDedupeKey } from "../src/lib/webhooks/dedupe.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const B = "booking-1";

// created / completed -> booking id (no booking_events row exists for these).
assert(
  webhookDedupeKey("booking.created", { bookingId: B, bookingEventId: null }) === B,
  "booking.created keys on the booking id",
);
assert(
  webhookDedupeKey("booking.completed", { bookingId: B, bookingEventId: "evt-x" }) === B,
  "booking.completed keys on the booking id (ignores any event id)",
);

// mutation events -> the booking_events row id (versioned).
for (const ev of ["booking.rescheduled", "booking.cancelled", "booking.reassigned"] as const) {
  assert(
    webhookDedupeKey(ev, { bookingId: B, bookingEventId: "evt-7" }) === "evt-7",
    `${ev} keys on the booking_events row id`,
  );
}

// Two distinct reschedules get distinct history ids -> distinct keys (not swallowed).
assert(
  webhookDedupeKey("booking.rescheduled", { bookingId: B, bookingEventId: "evt-7" }) !==
    webhookDedupeKey("booking.rescheduled", { bookingId: B, bookingEventId: "evt-8" }),
  "two reschedules with different history ids produce different keys",
);

// mutation with no history id (failed best-effort insert) -> null = no dedup.
assert(
  webhookDedupeKey("booking.cancelled", { bookingId: B, bookingEventId: null }) === null,
  "a mutation with no history id degrades to null (no dedup, at-least-once)",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
