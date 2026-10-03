// #3169: a booking reservation's lease is released only while the caller still
// holds it, through the same compare and swap the outbox lease uses (#1048).
//
// The defect: `releaseReservationLease` cleared `lease_until` by row id with no
// token check. A drain that overran the 2 minute lease released a lease it no
// longer owned, and the moment it no longer owns it is exactly the moment a second
// holder legitimately has it, so nulling it lets a third attempt start while the
// second is mid flight: two attempts working one lead's booking at once.
//
// The fake below is a tiny STATEFUL table rather than a recorder, so the test can
// interleave two real holders against one row and read what is left, in both
// orders: the older holder releasing late while the newer one still works, and the
// newer one finishing first while the older one's release arrives after a third
// has taken the row.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-reservation-lease.ts
import {
  leaseReservationRow,
  releaseReservationLeaseRow,
  leaseOutboxRow,
  releaseOutboxLeaseRow,
} from "../src/lib/booking/outbox-lease.ts";
import { isBookingWriteFailure } from "../src/lib/booking/gated-write.ts";
import { processBookingReservations } from "../src/lib/booking/orchestration.ts";
import { makeDeps } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const TTL = 2 * 60 * 1000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

interface Row {
  id: string;
  lease_until: string | null;
}

/** One table held in memory, answering the update chains the lease functions send. */
function memoryTable(table: string, rows: Row[], opts: { failWith?: string } = {}) {
  const tables: string[] = [];
  const db = {
    from(name: string) {
      tables.push(name);
      let values: Partial<Row> = {};
      const eqs: [keyof Row, unknown][] = [];
      let freeBefore: string | null = null;
      const builder = {
        update(v: Partial<Row>) {
          values = v;
          return builder;
        },
        eq(col: keyof Row, val: unknown) {
          eqs.push([col, val]);
          return builder;
        },
        or(filter: string) {
          // The only `or` either lease sends: free, or expired before an instant.
          const m = /^lease_until\.is\.null,lease_until\.lt\.(.+)$/.exec(filter);
          if (!m) throw new Error(`unexpected filter ${filter}`);
          freeBefore = m[1]!;
          return builder;
        },
        async select(cols: string) {
          if (opts.failWith) return { data: null, error: { message: opts.failWith } };
          if (name !== table) return { data: [], error: null };
          const hit = rows.filter(
            (r) =>
              eqs.every(([c, v]) => r[c] === v) &&
              (freeBefore === null ||
                r.lease_until === null ||
                Date.parse(r.lease_until) < Date.parse(freeBefore)),
          );
          for (const r of hit) Object.assign(r, values);
          return {
            data: hit.map((r) => (cols === "lease_until" ? { lease_until: r.lease_until } : { id: r.id })),
            error: null,
          };
        },
      };
      return builder;
    },
  };
  return { db: db as never, tables };
}

// --- the claim -----------------------------------------------------------------
{
  const row: Row = { id: "res-1", lease_until: null };
  const { db, tables } = memoryTable("booking_reservations", [row]);
  const a = await leaseReservationRow(db, "res-1", T0, TTL);
  eq(a, new Date(T0 + TTL).toISOString(), "a free reservation is leased, and the token is the stored value");
  eq(tables[0], "booking_reservations", "the claim is on the reservations table");
  eq(
    await leaseReservationRow(db, "res-1", T0 + 1000, TTL),
    null,
    "a reservation already leased is not leased again, so two drains cannot both run it",
  );
}
{
  // #2373 still holds: a claim the database refused is not a lost race.
  const { db } = memoryTable("booking_reservations", [{ id: "res-1", lease_until: null }], {
    failWith: "permission denied",
  });
  let caught: unknown;
  try {
    await leaseReservationRow(db, "res-1", T0, TTL);
  } catch (err) {
    caught = err;
  }
  assert(isBookingWriteFailure(caught), "a refused claim throws the write failure, never reads as busy");
  assert(
    isBookingWriteFailure(caught) && caught.op === "reservation_lease",
    "and names the reservation lease as the statement that failed",
  );
}

// --- interleaving, direction one: the OLDER holder releases late --------------
{
  const row: Row = { id: "res-1", lease_until: null };
  const { db } = memoryTable("booking_reservations", [row]);
  const a = await leaseReservationRow(db, "res-1", T0, TTL);
  assert(a !== null, "holder A takes the lease");
  // A overruns. Past its expiry, the next drain legitimately takes the row.
  const b = await leaseReservationRow(db, "res-1", T0 + TTL + 1, TTL);
  assert(b !== null && b !== a, "holder B takes the expired lease with a token of its own");
  // A finishes and releases in its finally. This is the line that used to free B's lease.
  await releaseReservationLeaseRow(db, "res-1", a!);
  eq(row.lease_until, b, "A's late release leaves B's lease standing");
  eq(
    await leaseReservationRow(db, "res-1", T0 + TTL + 2, TTL),
    null,
    "so a third drain cannot start while B is mid flight",
  );
  await releaseReservationLeaseRow(db, "res-1", b!);
  eq(row.lease_until, null, "B's own release does free the row");
}

// --- interleaving, direction two: the NEWER holder finishes first -------------
{
  const row: Row = { id: "res-1", lease_until: null };
  const { db } = memoryTable("booking_reservations", [row]);
  const a = await leaseReservationRow(db, "res-1", T0, TTL);
  const b = await leaseReservationRow(db, "res-1", T0 + TTL + 1, TTL);
  assert(a !== null && b !== null, "A and then B hold the row in turn");
  await releaseReservationLeaseRow(db, "res-1", b!);
  eq(row.lease_until, null, "B finishes first and frees the row");
  const c = await leaseReservationRow(db, "res-1", T0 + TTL + 2, TTL);
  assert(c !== null && c !== a, "holder C takes the freed row");
  await releaseReservationLeaseRow(db, "res-1", a!);
  eq(row.lease_until, c, "A's release, arriving after both, leaves C's lease standing");
}

// --- one mechanism, not two (L41) ----------------------------------------------
{
  // The outbox goes through the same claim and release, so the two cannot drift.
  const row: Row = { id: "ob-1", lease_until: null };
  const { db, tables } = memoryTable("booking_outbox", [row]);
  const a = await leaseOutboxRow(db, "ob-1", T0);
  const b = await leaseOutboxRow(db, "ob-1", T0 + TTL + 1);
  assert(a !== null && b !== null && a !== b, "the outbox lease interleaves the same way");
  await releaseOutboxLeaseRow(db, "ob-1", a!);
  eq(row.lease_until, b, "and its stale release leaves the newer lease standing too");
  assert(tables.every((t) => t === "booking_outbox"), "the outbox writes only the outbox table");
}

// --- the drain hands its own token back ----------------------------------------
{
  const reservation = {
    id: "res-9",
    idempotency_key: "k",
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: "",
    updated_at: "",
  };
  const { deps } = makeDeps({
    drainableReservations: [reservation] as unknown as Parameters<typeof makeDeps>[0]["drainableReservations"],
  });
  const released: [string, string][] = [];
  deps.leaseReservation = async () => "token-9";
  deps.releaseReservationLease = async (id: string, lease: string) => {
    released.push([id, lease]);
  };
  await processBookingReservations(deps, 5);
  eq(released, [["res-9", "token-9"]], "the drain releases with the token its own claim returned");

  const releasedWhenLost: unknown[] = [];
  deps.leaseReservation = async () => null;
  deps.releaseReservationLease = async (...args: unknown[]) => {
    releasedWhenLost.push(args);
  };
  await processBookingReservations(deps, 5);
  eq(releasedWhenLost.length, 0, "a drain that never won the lease releases nothing");
}

finish();
