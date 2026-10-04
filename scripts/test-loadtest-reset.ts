// #3258: the reset between load run arms.
//
// Three arms of the post confirm recompute experiment can share one branch and
// one deployment only if each arm starts from the state the first one did: the
// previous arm's bookings make agents busier, count against daily caps and widen
// every candidate read, and its leftover outbox, reservations and rate limit rows
// add work and refusals the next arm would be measured under.
//
// Pinned here, each from both sides (L1, L159):
//   1. the ORDER: bookings first (their cascades remove only the busy blocks tied to
//      a booking, never the seeded calendar time), then the tables bookings only
//      null their reference in;
//   2. the COUNTS: every delete reports how many rows it removed;
//   3. the REFUSALS: production by the guard the seed uses, and any bulk reassign
//      row, named, before a single row is deleted; and it never truncates.
//
// Run: node --experimental-strip-types scripts/test-loadtest-reset.ts
import { readFileSync } from "node:fs";
import { RESET_ORDER, resetBranch, type ResetClient } from "./loadtest/reset-plan.ts";
import { productionRefusal } from "./loadtest/seed-guards.ts";
import { PRODUCTION_SUPABASE_REF } from "../src/lib/loadtest-guard.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function fakeClient(rows: Record<string, number>, bulk: { table: string; id: string } | null = null) {
  const calls: string[] = [];
  const client: ResetClient = {
    firstBulkReassignRow: async () => {
      calls.push("check-bulk");
      return bulk;
    },
    deleteAll: async (table) => {
      calls.push(`delete:${table}`);
      const n = rows[table] ?? 0;
      rows[table] = 0;
      return n;
    },
  };
  return { client, calls };
}

// --- the order and the counts ------------------------------------------------------
eq(
  [...RESET_ORDER],
  ["bookings", "booking_outbox", "booking_reservations", "pending_event_deletions", "routing_decisions", "rate_limits"],
  "bookings first, then the tables that only null their reference, then rate limits",
);
{
  const rows = { bookings: 631, booking_outbox: 4, booking_reservations: 2, pending_event_deletions: 0, routing_decisions: 640, rate_limits: 37 };
  const { client, calls } = fakeClient({ ...rows });
  const result = await resetBranch(client);
  eq(calls[0], "check-bulk", "the bulk reassign check runs before anything is deleted");
  eq(calls.slice(1), RESET_ORDER.map((t) => `delete:${t}`), "then each table, in order, once");
  eq(result, { ok: true, deleted: RESET_ORDER.map((t) => ({ table: t, rows: rows[t as keyof typeof rows] })) }, "every delete reports its own row count");
}

// --- the bulk reassign refusal ------------------------------------------------------
{
  const { client, calls } = fakeClient({ bookings: 5 }, { table: "bulk_reassign_items", id: "item-1" });
  const result = await resetBranch(client);
  assert(!result.ok, "a bulk reassign row refuses the reset");
  assert(!result.ok && result.why.includes("bulk_reassign_items") && result.why.includes("item-1"), "naming the table and the row");
  eq(calls, ["check-bulk"], "and nothing at all is deleted");
}

// --- production -----------------------------------------------------------------------
{
  const prod = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
  assert(productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }) !== null, "the shared guard refuses production");
  assert(
    productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: false, action: "reset" })!.includes("reset"),
    "naming what it refused to do",
  );
  eq(productionRefusal("https://abcbranch.supabase.co", PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }), null, "a branch passes (positive control)");
  eq(productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: true, action: "seed" }), null, "the seed's FORCE still works for the seed");
  assert(productionRefusal("", PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }) !== null, "an empty address refuses rather than passing");
  // The reset never takes FORCE: deleting every booking is not something to do to
  // production on purpose either. Pinned on the entry point's source, because the
  // entry is what reads the environment.
  const entry = readFileSync(new URL("./loadtest/reset.ts", import.meta.url), "utf8");
  assert(/productionRefusal\([^)]*force: false/.test(entry), "the reset entry calls the shared guard with force off");
  assert(!/process\.env\.FORCE/.test(entry), "and never reads FORCE");
  const seed = readFileSync(new URL("./loadtest/seed.ts", import.meta.url), "utf8");
  assert(/productionRefusal\(/.test(seed), "the seed refuses production through the same guard");
  for (const src of [entry, readFileSync(new URL("./loadtest/reset-plan.ts", import.meta.url), "utf8")]) {
    assert(!/truncate/i.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\/|^\s*\*.*$/gm, "")), "and no code in the reset truncates");
  }
}

finish();
