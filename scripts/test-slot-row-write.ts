// #1048: a slower recompute must not overwrite a fresher precomputed row.
//
// `bucket_slots` held one unconditional upsert per bucket, stamped `computed_at` at
// WRITE time. Two things followed from that pair, and the second is the one that
// hides the first: a compute that started before a booking (so it read pre-booking
// state) and finished after a faster one could overwrite the fresher row, and because
// the stamp was taken when the write happened, the row it left behind LOOKED like the
// newest data. The `x-slots-computed-at` header then reported a fresh stamp over stale
// slots, so the regression was invisible on the one surface that exists to show it.
//
// Both halves are fixed together, and neither works alone. The stamp is taken when the
// COMPUTE started, so it describes the data rather than the moment it landed; and the
// write only overwrites a row that is older than that stamp.
//
// Bounded by the 1 minute cron and by verify-on-book either way, so this is about the
// stamp telling the truth as much as about the overwrite.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-slot-row-write.ts
import { writeSlotRow } from "../src/lib/availability/slot-row-write.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface Recorded {
  kind: "update" | "insert";
  values: Record<string, unknown>;
  eq: [string, unknown][];
  lt: [string, unknown][];
}

/**
 * A db fake that answers a scripted sequence of results, one per statement, and
 * records the chain. `results` is consumed in order so a test can drive the
 * update-misses-then-insert-conflicts path exactly.
 */
function fakeDb(results: { rows?: unknown[]; error?: { code?: string; message: string } }[]) {
  const calls: Recorded[] = [];
  const answer = () => {
    const r = results.shift() ?? { rows: [] };
    return Promise.resolve({
      data: r.error ? null : (r.rows ?? []),
      error: r.error ?? null,
    });
  };
  const db = {
    from(_table: string) {
      return {
        update(values: Record<string, unknown>) {
          const rec: Recorded = { kind: "update", values, eq: [], lt: [] };
          calls.push(rec);
          const b: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              rec.eq.push([col, val]);
              return b;
            },
            lt(col: string, val: unknown) {
              rec.lt.push([col, val]);
              return b;
            },
            select: () => answer(),
          };
          return b;
        },
        insert(values: Record<string, unknown>) {
          calls.push({ kind: "insert", values, eq: [], lt: [] });
          return answer();
        },
      };
    },
  };
  return { db: db as never, calls };
}

const STARTED = Date.parse("2026-09-01T12:00:00.000Z");
const STAMP = new Date(STARTED).toISOString();
const PAYLOAD = { slots: [{ start: "2026-09-02T13:00:00.000Z" }] };

// --- the stamp describes the COMPUTE, not the write ---------------------------
{
  const { db, calls } = fakeDb([{ rows: [{ bucket_code: "101" }] }]);
  eq(await writeSlotRow(db, "101", PAYLOAD, STARTED), "written", "the usual path writes");

  const upd = calls[0]!;
  eq(upd.kind, "update", "an existing row is updated in place");
  eq(upd.values.computed_at, STAMP, "computed_at is the instant the compute STARTED");
  eq(upd.values.payload, PAYLOAD, "and it carries the freshly computed payload");
  assert(
    upd.eq.some(([c, v]) => c === "bucket_code" && v === "101"),
    "scoped to the bucket",
  );
  // The gate. Without it this is the unconditional upsert again.
  assert(
    upd.lt.some(([c, v]) => c === "computed_at" && v === STAMP),
    "and gated on the stored row being OLDER than this compute",
  );
}

// --- a fresher row stands -----------------------------------------------------
{
  // The update matches nothing (the stored row is newer or equal), so the insert is
  // tried and hits the primary key. That combination is the proof a fresher row
  // exists, and it must be LEFT ALONE.
  const { db, calls } = fakeDb([
    { rows: [] },
    { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    { rows: [] },
  ]);
  eq(
    await writeSlotRow(db, "101", PAYLOAD, STARTED),
    "kept-newer",
    "a slower compute leaves the fresher row alone",
  );
  eq(calls.length, 3, "and it took the update, the insert, and one re-check");
  eq(calls[2]!.kind, "update", "the re-check is the same gated update");
}

// --- the first ever write for a bucket ----------------------------------------
{
  // No row yet: the gated update matches nothing, and the insert is what creates it.
  // Without this branch the very first compute for a bucket would never be stored.
  const { db, calls } = fakeDb([{ rows: [] }, { rows: [{ bucket_code: "101" }] }]);
  eq(await writeSlotRow(db, "101", PAYLOAD, STARTED), "written", "a bucket with no row is inserted");
  eq(calls[1]!.kind, "insert", "through an insert");
  eq(calls[1]!.values.computed_at, STAMP, "carrying the compute-start stamp");
  eq(calls[1]!.values.bucket_code, "101", "and the bucket code");
}

// --- two writers racing to create the same row --------------------------------
{
  // Both find no row, both insert, one loses on the primary key. The loser's data may
  // be the NEWER of the two, so it must not simply give up: it re-runs the gated
  // update, which now sees the winner's row and overwrites it only if it is older.
  const { db, calls } = fakeDb([
    { rows: [] },
    { error: { code: "23505", message: "duplicate key" } },
    { rows: [{ bucket_code: "101" }] },
  ]);
  eq(
    await writeSlotRow(db, "101", PAYLOAD, STARTED),
    "written",
    "the loser of an insert race still writes when its data is newer",
  );
  eq(calls[2]!.kind, "update", "via the gated update, so it can never overwrite a fresher row");
}

// --- failures are their own outcome -------------------------------------------
{
  const { db } = fakeDb([{ error: { message: "connection reset" } }]);
  eq(
    await writeSlotRow(db, "101", PAYLOAD, STARTED),
    "failed",
    "an update error is a failure, never a kept-newer and never a write",
  );
}
{
  // An insert error that is NOT a duplicate says nothing about a fresher row.
  const { db } = fakeDb([{ rows: [] }, { error: { code: "42703", message: "no such column" } }]);
  eq(
    await writeSlotRow(db, "101", PAYLOAD, STARTED),
    "failed",
    "an insert error other than a duplicate is a failure, not a fresher row",
  );
}

finish();
