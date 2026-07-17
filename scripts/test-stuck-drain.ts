// Unit test (#517) for the stuck-drain normalization core.
//
// The admin "stuck deliveries" view lists booking_outbox and booking_reservation
// rows whose durable drain (#445) keeps failing (attempts >= DRAIN_ALERT_AFTER).
// The two tables have different shapes; this core normalizes each into one
// StuckRow so the page renders a single model. Pure, so it is node-native testable
// with hand-written fixtures.
//
// Run: node --experimental-strip-types scripts/test-stuck-drain.ts
import {
  normalizeOutboxRow,
  normalizeReservationRow,
  summarizeStuck,
  type StuckRow,
} from "@/lib/booking/stuck-drain";
import { DRAIN_ALERT_AFTER, DRAIN_GIVE_UP_AT } from "@/lib/booking/drain-backoff";
import { assert, eq, finish } from "./lib/harness.ts";

const outbox = {
  id: "ob-1",
  booking_id: "bk-9",
  action: "reschedule" as const,
  attempts: 7,
  last_error: "google 503",
  next_attempt_at: "2026-07-17T18:05:00Z",
  created_at: "2026-07-17T17:00:00Z",
  updated_at: "2026-07-17T18:00:00Z",
};

const reservation = {
  id: "rs-1",
  idempotency_key: "idem-abc",
  attempts: DRAIN_GIVE_UP_AT,
  last_error: null,
  next_attempt_at: null,
  created_at: "2026-07-16T10:00:00Z",
  updated_at: "2026-07-17T09:00:00Z",
};

// --- outbox normalization -----------------------------------------------------

const ob = normalizeOutboxRow(outbox);
eq(ob.kind, "outbox", "outbox row normalizes to kind=outbox");
eq(ob.action, "reschedule", "outbox action is carried through");
eq(ob.ref, "bk-9", "outbox reference is the booking_id");
eq(ob.attempts, 7, "outbox attempts carried through");
eq(ob.lastError, "google 503", "outbox last_error carried through");
eq(ob.nextAttemptAt, "2026-07-17T18:05:00Z", "outbox next_attempt_at carried through");
assert(ob.gaveUp === false, "an outbox row below the give-up cap is not gaveUp");

// --- reservation normalization ------------------------------------------------

const rs = normalizeReservationRow(reservation);
eq(rs.kind, "reservation", "reservation row normalizes to kind=reservation");
eq(rs.action, "create", "a reservation is always a crash-recovered create");
eq(rs.ref, "idem-abc", "reservation reference is the idempotency_key");
eq(rs.lastError, null, "a null last_error stays null (not yet errored / cleared)");
eq(rs.nextAttemptAt, null, "a null next_attempt_at stays null (eligible to retry now)");
assert(rs.gaveUp === true, "a reservation at the give-up cap is flagged gaveUp");

// --- give-up boundary ---------------------------------------------------------

assert(
  normalizeOutboxRow({ ...outbox, attempts: DRAIN_GIVE_UP_AT - 1 }).gaveUp === false,
  "one below the give-up cap is still retrying (not gaveUp)",
);
assert(
  normalizeOutboxRow({ ...outbox, attempts: DRAIN_GIVE_UP_AT }).gaveUp === true,
  "at the give-up cap the row is gaveUp",
);
assert(DRAIN_ALERT_AFTER < DRAIN_GIVE_UP_AT, "alert threshold is below the give-up cap (sanity)");

// --- summary counts -----------------------------------------------------------

const rows: StuckRow[] = [
  ob,
  rs,
  normalizeOutboxRow({ ...outbox, id: "ob-2", attempts: DRAIN_GIVE_UP_AT }),
];
const s = summarizeStuck(rows);
eq(s.total, 3, "summary counts every stuck row");
eq(s.outbox, 2, "summary counts outbox rows");
eq(s.reservations, 1, "summary counts reservation rows");
eq(s.gaveUp, 2, "summary counts the given-up rows across both kinds");

finish();
