// Regal call events are idempotent on Regal's event id at the STORE, not only in
// the decision logic (#3110). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-store-idempotent.ts
//
// The inbound feed's bearer is static and Regal can redeliver, so a replayed body
// must land as the same one row. scripts/test-regal-inbound-call.ts proves the
// decision half against a fake store that already dedupes; this drives the REAL
// store functions against a fake query builder and pins the two things the fake
// there takes on trust: each write is an ON CONFLICT (event_id) DO NOTHING, and an
// ignored row (the empty array PostgREST returns) reads as a duplicate rather than
// a fresh write.

import { regalCallStore, regalCallOutcomeStore } from "@/lib/regal/call-store";
import { assert, eq, finish } from "./lib/harness.ts";
import type { RegalCallOutcomeRow, RegalCallRow } from "@/lib/regal/inbound-call";

type Upsert = { table: string; row: Record<string, unknown>; opts: unknown };

/** A query builder that keeps one row per event_id, as the unique constraint does. */
function fakeDb() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const upserts: Upsert[] = [];
  const db = {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: { onConflict?: string; ignoreDuplicates?: boolean }) => ({
        select: async () => {
          upserts.push({ table, row, opts });
          const t = tables.get(table) ?? new Map();
          tables.set(table, t);
          const key = String(row[opts.onConflict ?? "id"]);
          if (t.has(key) && opts.ignoreDuplicates) return { data: [], error: null };
          t.set(key, row);
          return { data: [{ id: `${table}-${t.size}` }], error: null };
        },
      }),
    }),
  };
  return { db, upserts, tables };
}

const EVENT = "0123456789abcdef0123456789abcdef";

{
  const { db, upserts, tables } = fakeDb();
  const store = regalCallStore(db as never);
  const row: RegalCallRow = { event_id: EVENT, reason: "candidate", agent_email: "a@trypennie.com", occurred_at: "2026-10-03T12:00:00.000Z" } as RegalCallRow;
  eq(await store.insert(row), "inserted", "the first delivery is a write");
  eq(await store.insert(row), "duplicate", "the same event id again is a duplicate");
  eq(tables.get("regal_call_events")?.size, 1, "and the table holds one row for it");
  const opts = upserts[0]?.opts as { onConflict?: string; ignoreDuplicates?: boolean };
  eq(opts.onConflict, "event_id", "the detector write conflicts on Regal's event id");
  eq(opts.ignoreDuplicates, true, "and does nothing on a conflict, so the first delivery's row stands");
}

{
  const { db, upserts, tables } = fakeDb();
  const store = regalCallOutcomeStore(db as never);
  const row = { event_id: EVENT } as unknown as RegalCallOutcomeRow;
  eq(await store.insertOutcome(row), "inserted", "the first outcome is a write");
  eq(await store.insertOutcome(row), "duplicate", "a replayed outcome is a duplicate");
  eq(tables.get("regal_call_outcomes")?.size, 1, "and the show rate counts the call once");
  const opts = upserts[0]?.opts as { onConflict?: string; ignoreDuplicates?: boolean };
  eq(opts.onConflict, "event_id", "the outcome write conflicts on Regal's event id");
  eq(opts.ignoreDuplicates, true, "and does nothing on a conflict");
}

// A failed write is never read as a duplicate: that would drop the event silently.
{
  const db = {
    from: () => ({ upsert: () => ({ select: async () => ({ data: null, error: { message: "boom" } }) }) }),
  };
  let threw = false;
  try {
    await regalCallOutcomeStore(db as never).insertOutcome({ event_id: EVENT } as unknown as RegalCallOutcomeRow);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("boom");
  }
  assert(threw, "a failed outcome write throws with the database's reason");
}

finish();
