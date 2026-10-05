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
import { FENCE_PATH, markSlotRowsInvalidated, writeSlotRow } from "../src/lib/availability/slot-row-write.ts";
import { fakeBucketSlotsTable, type SlotRow } from "./lib/fake-bucket-slots-table.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface Recorded {
  kind: "update" | "insert";
  values: Record<string, unknown>;
  eq: [string, unknown][];
  lt: [string, unknown][];
  or: string[];
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
          const rec: Recorded = { kind: "update", values, eq: [], lt: [], or: [] };
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
            or(expr: string) {
              rec.or.push(expr);
              return b;
            },
            select: () => answer(),
          };
          return b;
        },
        insert(values: Record<string, unknown>) {
          calls.push({ kind: "insert", values, eq: [], lt: [], or: [] });
          return answer();
        },
        // The one read: why a refused write was refused. Answers the next scripted
        // result's first row, or no row.
        select(_cols: string) {
          const b: Record<string, unknown> = {
            eq: () => b,
            maybeSingle: async () => {
              const r = await answer();
              return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
            },
          };
          return b;
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
  // #3118: and on no save having invalidated the row since this compute began, and
  // #3324: no booking having been spliced into it since then. One expression, every
  // combination of the two spelled out.
  eq(
    upd.or,
    [
      [
        `and(invalidated_at.is.null,${FENCE_PATH}.is.null)`,
        `and(invalidated_at.is.null,${FENCE_PATH}.lt.${STAMP})`,
        `and(invalidated_at.lt.${STAMP},${FENCE_PATH}.is.null)`,
        `and(invalidated_at.lt.${STAMP},${FENCE_PATH}.lt.${STAMP})`,
      ].join(","),
    ],
    "and gated on the row not having been invalidated or spliced at or after this compute began",
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
    { rows: [{ computed_at: "2026-09-01T12:00:05.000Z", invalidated_at: null }] },
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

// --- a compute that straddles an event type save must not land (#3118) --------
//
// An admin save marks every row stale so the recompute lane rebuilds it under the
// new settings. A compute that STARTED before the save read the old settings, and
// its stamp (the compute start) is newer than the epoch the save wrote, so the
// computed_at gate alone let it overwrite the stale mark. The row then looked fresh
// for the whole freshness window while offering times under the old settings.
//
// So the save also records `invalidated_at`, and a write whose compute began at or
// before that instant is refused. This drives the real interleaving against a
// table that applies the filters it is given: compute start, save, then write.

/** The shared in-memory table (#3324), which evaluates the filters it is given. */
function tableDb(rows: SlotRow[]) {
  const t = fakeBucketSlotsTable(rows);
  return { db: t.db, rows: t.rows };
}

{
  const OLD = { slots: ["old settings"] };
  const NEW = { slots: ["new settings"] };
  const computeStarted = Date.parse("2026-10-03T10:00:00.000Z");
  const savedAt = Date.parse("2026-10-03T10:00:01.000Z");
  const nextCompute = Date.parse("2026-10-03T10:01:00.000Z");

  const { db, rows } = tableDb([
    { bucket_code: "101", payload: OLD, computed_at: "2026-10-03T09:58:00.000Z", invalidated_at: null },
  ]);

  // 1. a compute starts and reads the old settings (nothing is written yet)
  // 2. the admin saves: every row is marked stale
  eq(await markSlotRowsInvalidated(db, savedAt), 1, "the save marks the one row");
  eq(rows[0].computed_at, "1970-01-01T00:00:00.000Z", "the row is back dated so the lane treats it as due");
  eq(rows[0].invalidated_at, new Date(savedAt).toISOString(), "and carries the instant it was invalidated");

  // 3. the straddling compute finishes and tries to write
  eq(
    await writeSlotRow(db, "101", OLD, computeStarted),
    "invalidated",
    "a compute that began before the save is refused, and says why",
  );
  eq(rows[0].computed_at, "1970-01-01T00:00:00.000Z", "so the row stays due and cannot look fresh");

  // 4. the next compute starts after the save and lands
  eq(await writeSlotRow(db, "101", NEW, nextCompute), "written", "a compute that began after the save writes");
  eq(rows[0].payload, NEW, "carrying the new settings");
  eq(rows[0].computed_at, new Date(nextCompute).toISOString(), "stamped from its own start");
}

{
  // A compute that began at the very instant of the save cannot be shown to have
  // read the new settings, so equality is refused too.
  const savedAt = Date.parse("2026-10-03T10:00:01.000Z");
  const { db } = tableDb([
    { bucket_code: "101", payload: {}, computed_at: "2026-10-03T09:00:00.000Z", invalidated_at: null },
  ]);
  await markSlotRowsInvalidated(db, savedAt);
  eq(await writeSlotRow(db, "101", {}, savedAt), "invalidated", "a compute starting at the save instant is refused");
}

{
  // A row ALREADY at the stale stamp (a second save while the first is draining)
  // must still be re-marked: a compute straddling the second save is just as wrong.
  const firstSave = Date.parse("2026-10-03T10:00:00.000Z");
  const computeStarted = Date.parse("2026-10-03T10:00:30.000Z");
  const secondSave = Date.parse("2026-10-03T10:00:40.000Z");
  const { db, rows } = tableDb([
    { bucket_code: "101", payload: {}, computed_at: "2026-10-03T09:00:00.000Z", invalidated_at: null },
  ]);
  await markSlotRowsInvalidated(db, firstSave);
  eq(await markSlotRowsInvalidated(db, secondSave), 1, "a second save re-marks a row that is already stale");
  eq(rows[0].invalidated_at, new Date(secondSave).toISOString(), "moving its invalidation forward");
  eq(await writeSlotRow(db, "101", {}, computeStarted), "invalidated", "so a compute between the two saves is refused");
}

{
  // CONTROL: an ordinary overlap with no save in it is still the fresher row standing.
  const { db } = tableDb([
    { bucket_code: "101", payload: {}, computed_at: "2026-10-03T10:00:05.000Z", invalidated_at: null },
  ]);
  eq(
    await writeSlotRow(db, "101", {}, Date.parse("2026-10-03T10:00:00.000Z")),
    "kept-newer",
    "with no invalidation, a slower compute is still reported as keeping the fresher row",
  );
}

finish();
