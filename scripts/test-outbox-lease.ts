// #1048: every write a leased outbox row receives is gated on the lease the writer
// actually holds.
//
// The defect: `releaseOutboxLease` cleared `lease_until` unconditionally by row id,
// unlike `releaseLock` and the reschedule takeover beside it, which both gate on the
// holder's own claim. So a holder that overran the 2 minute lease released a lease it
// no longer owned. That is the moment a SECOND holder legitimately took over, and
// nulling its lease lets a THIRD start while the second is mid flight. Every comment
// in the executor that says "the row is leased, so no concurrent writer races this
// whole array write" is then false, and the whole array write is exactly what makes
// that matter: a stale copy of `steps` overwrites a live holder's progress and its
// recorded failure text, so a step re-runs and its diagnosis is gone.
//
// The gate is a compare and swap on the token, which is the value the DATABASE holds
// rather than the string we computed: the token is read back from the write that set
// it, so a store that renders a timestamp differently cannot make every later
// comparison quietly false.
//
// Three outcomes, deliberately distinct (L11), because collapsing them is how a lost
// lease and a broken database read the same:
//   written    the row is ours and the write landed
//   lease-lost somebody else holds it now; stop touching the row
//   failed     the write itself errored; stop, and say so
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-outbox-lease.ts
import {
  leaseOutboxRow,
  saveOutboxStepsRow,
  markOutboxDeliveredRow,
  releaseOutboxLeaseRow,
  OUTBOX_LEASE_TTL_MS,
} from "../src/lib/booking/outbox-lease.ts";
import type { OutboxStep } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface Recorded {
  table: string;
  update?: Record<string, unknown>;
  eq: [string, unknown][];
  or: string[];
  select?: string;
}

/** A db fake that records the chain and answers with `rows`. */
function fakeDb(result: { rows?: unknown[]; error?: { message: string } | null }) {
  const calls: Recorded[] = [];
  const db = {
    from(table: string) {
      const rec: Recorded = { table, eq: [], or: [] };
      calls.push(rec);
      const builder: Record<string, unknown> = {
        update(vals: Record<string, unknown>) {
          rec.update = vals;
          return builder;
        },
        eq(col: string, val: unknown) {
          rec.eq.push([col, val]);
          return builder;
        },
        or(filter: string) {
          rec.or.push(filter);
          return builder;
        },
        select(cols: string) {
          rec.select = cols;
          return Promise.resolve({
            data: result.error ? null : (result.rows ?? []),
            error: result.error ?? null,
          });
        },
      };
      return builder;
    },
  };
  return { db: db as never, calls };
}

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const STEPS: OutboxStep[] = [{ name: "a", state: "done" }];

// --- leaseOutboxRow -----------------------------------------------------------
{
  // The token comes from the row the database returned, not from the string we sent.
  // If those ever render differently, every later `.eq` would silently match nothing.
  const stored = "2026-09-01 12:02:00+00";
  const { db, calls } = fakeDb({ rows: [{ lease_until: stored }] });
  const lease = await leaseOutboxRow(db, "ob-1", NOW);

  eq(lease, stored, "the lease token is the value the database reports, not ours");
  eq(calls[0]?.table, "booking_outbox", "leases the outbox row");
  assert(
    calls[0]!.eq.some(([c, v]) => c === "id" && v === "ob-1"),
    "scoped to the one row",
  );
  assert(
    calls[0]!.or.length === 1 && calls[0]!.or[0]!.includes("lease_until.is.null"),
    "claims only a free or expired lease, so two drains cannot both take it",
  );
  const wrote = calls[0]!.update?.lease_until as string;
  eq(
    Date.parse(wrote) - NOW,
    OUTBOX_LEASE_TTL_MS,
    "the lease it writes runs one full TTL from the injected clock",
  );
}
{
  // Somebody else holds it: the gated update matches nothing.
  const { db } = fakeDb({ rows: [] });
  eq(await leaseOutboxRow(db, "ob-1", NOW), null, "a row already leased returns no token");
}
{
  // A read error must not look like a won lease.
  const { db } = fakeDb({ error: { message: "boom" } });
  eq(await leaseOutboxRow(db, "ob-1", NOW), null, "a failed claim returns no token");
}

// --- saveOutboxStepsRow -------------------------------------------------------
{
  const lease = "2026-09-01 12:02:00+00";
  const { db, calls } = fakeDb({ rows: [{ id: "ob-1" }] });
  eq(await saveOutboxStepsRow(db, "ob-1", STEPS, lease, NOW), "written", "a held row saves");
  assert(
    calls[0]!.eq.some(([c, v]) => c === "lease_until" && v === lease),
    "the save is gated on the holder's own token",
  );
  assert(
    calls[0]!.eq.some(([c, v]) => c === "id" && v === "ob-1"),
    "and on the row id",
  );
}
{
  // The case the whole change is about: our token is no longer the row's.
  const { db } = fakeDb({ rows: [] });
  eq(
    await saveOutboxStepsRow(db, "ob-1", STEPS, "stale-token", NOW),
    "lease-lost",
    "a save that matches no row reports the lease is gone rather than success",
  );
}
{
  const { db } = fakeDb({ error: { message: "connection reset" } });
  eq(
    await saveOutboxStepsRow(db, "ob-1", STEPS, "tok", NOW),
    "failed",
    "a write error is its own outcome, never a lost lease and never success",
  );
}

// --- markOutboxDeliveredRow ---------------------------------------------------
{
  const lease = "tok";
  const { db, calls } = fakeDb({ rows: [{ id: "ob-1" }] });
  eq(await markOutboxDeliveredRow(db, "ob-1", lease, NOW), "written", "a held row is delivered");
  eq(calls[0]!.update?.status, "delivered", "sets the status");
  eq(calls[0]!.update?.lease_until, null, "and drops the lease in the same statement");
  assert(
    calls[0]!.eq.some(([c, v]) => c === "lease_until" && v === lease),
    "gated on the holder's token, so a stale holder cannot declare delivery",
  );
}
{
  const { db } = fakeDb({ rows: [] });
  eq(
    await markOutboxDeliveredRow(db, "ob-1", "stale", NOW),
    "lease-lost",
    "a stale holder cannot mark the row delivered",
  );
}

// --- releaseOutboxLeaseRow ----------------------------------------------------
{
  const lease = new Date(NOW + OUTBOX_LEASE_TTL_MS).toISOString();
  const { db, calls } = fakeDb({ rows: [{ id: "ob-1" }] });
  await releaseOutboxLeaseRow(db, "ob-1", lease);
  // #3169: freed to the claim instant, which is past, rather than to null, so the
  // next claim can never be handed this same token (scripts/test-reservation-lease.ts).
  eq(calls[0]!.update?.lease_until, new Date(NOW).toISOString(), "frees the lease back to its claim instant");
  assert(
    calls[0]!.eq.some(([c, v]) => c === "lease_until" && v === lease),
    "ONLY when the row still holds the token we wrote, which is the whole fix",
  );
}
{
  // A release that matches nothing is correct and silent: releasing a lease you no
  // longer hold is a no-op, which is precisely the outcome being bought here.
  const { db } = fakeDb({ rows: [] });
  await releaseOutboxLeaseRow(db, "ob-1", "stale");
  assert(true, "a stale release matches no row and throws nothing");
}

finish();
