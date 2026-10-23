import { log } from "../log.ts";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import {
  freshFences,
  mergeFreshSplices,
  spliceMetaOf,
  splicePayload,
  windowsOverlap,
  type SlotLists,
  type SplicePart,
} from "./slot-splice.ts";
import { stampWriter, type WrittenBy } from "./slot-row-writer.ts";
import { withStartedColumn } from "./slot-row-times.ts";

/**
 * The one write into `bucket_slots` (#1048).
 *
 * This used to be an unconditional upsert stamping `computed_at` at WRITE time, and the
 * two halves of that compounded. A compute that started before a booking (so it read
 * pre-booking state) and finished after a faster one could overwrite the fresher row;
 * and because the stamp was taken when the write landed, the row it left behind LOOKED
 * like the newest data, so `x-slots-computed-at` reported a fresh stamp over stale
 * slots and the regression was invisible on the one surface that exists to show it.
 *
 * Both halves are fixed together and neither works alone:
 *
 *   - `computed_at` is the instant the COMPUTE started, so it describes the data
 *     rather than the moment it arrived;
 *   - the write only overwrites a row OLDER than that stamp.
 *
 * The damage was always bounded (the 1 minute cron reconverges, and verify-on-book
 * stops a stale slot becoming a bad booking), so this is as much about the stamp
 * telling the truth as about the overwrite.
 *
 * Extracted as a `db`-injected seam so the compare and swap is actually tested:
 * `scripts/test-slot-row-write.ts`.
 */

/** What the write did. `kept-newer` is a success: a fresher row already stands.
 *  `invalidated` is one too: a save marked the row stale after this compute began,
 *  so its slots describe the old settings and the row stays due (#3118). */
export type SlotRowWriteOutcome = "written" | "kept-newer" | "invalidated" | "failed";

/**
 * Thrown by a writer that must not report a refused row as stored (#3119). The
 * write answers "failed" rather than throwing, and every caller that only awaited it
 * counted the refusal as a refresh; a caller that needs the answer as a value uses
 * `storeBucketSlotsRow` instead.
 */
export class SlotRowRefused extends Error {
  readonly bucketCode: string;
  constructor(bucketCode: string) {
    super(`the bucket_slots row for ${bucketCode} was refused, so it was not stored`);
    this.name = "SlotRowRefused";
    this.bucketCode = bucketCode;
  }
}

/** Typed as the real client rather than a hand-written slice: a structural interface
 *  makes tsc walk the client's generics at the call site until it gives up (TS2589). */
export type SlotRowDb = ReturnType<typeof supabaseAdmin>;

/** Postgres unique/primary key violation: the row already exists. */
const UNIQUE_VIOLATION = "23505";

/**
 * Store a bucket's freshly computed payload, stamped from `computedAtMs` (when the
 * compute began), overwriting only a row that is older than that.
 *
 * There is no single statement for this: PostgREST's upsert takes no WHERE, so the
 * conditional overwrite is a gated UPDATE, an INSERT when no row exists, and one
 * re-check of the gated UPDATE if that INSERT loses a create race. The re-check is not
 * belt and braces: two writers can both find no row, and the one that loses the
 * primary key may be holding the NEWER data, so giving up there would keep the older
 * of the two.
 */
export async function writeSlotRow(
  db: SlotRowDb,
  code: string,
  computed: unknown,
  computedAtMs: number,
  /**
   * The path storing this compute (#3381), stamped into the payload so a row that
   * disagrees with the confirm's candidate read can be traced to who wrote it.
   * Required, so `tsc` names every site that stores a full compute. A coalesced
   * refresh passes every requester (`joinWriters`).
   */
  writtenBy: WrittenBy,
  /**
   * When the compute that produced `computed` began (#3388), stored as
   * `compute_started_at` for the scheduling readers. Defaults to `computedAtMs`,
   * which is what every compute that read nothing older than its own start passes.
   * The gate below never reads it: freshness of the DATA is the stamp's question.
   */
  computeStartedAtMs: number = computedAtMs,
): Promise<SlotRowWriteOutcome> {
  const times: RowTimes = {
    computed_at: new Date(computedAtMs).toISOString(),
    compute_started_at: new Date(computeStartedAtMs).toISOString(),
  };
  const payload = stampWriter(computed, writtenBy);

  const first = await gatedUpdate(db, code, payload, times);
  if (first !== "no-row") return first;

  // Nothing older to overwrite. Either the bucket has no row at all, or the row that
  // is there is at least as fresh as this compute. The insert tells us which.
  const { error } = await withStartedColumn(
    (withStarted) =>
      db.from("bucket_slots").insert({ bucket_code: code, payload, ...timesFor(times, withStarted) }),
    SLOT_WRITE,
  );
  if (!error) return "written";
  if (error.code !== UNIQUE_VIOLATION) {
    log.warn("precompute", { msg: "slot row insert failed", bucket: code }, error);
    return "failed";
  }

  // A row exists. Re-run the gate: if it is older than this compute (a create race we
  // lost while holding newer data), overwrite it; otherwise it is genuinely fresher,
  // or a save invalidated it after this compute began, and it stands.
  const second = await gatedUpdate(db, code, payload, times);
  return second === "no-row" ? settleRefused(db, code, payload, computedAtMs, times) : second;
}

/** The two times a full compute writes (#3388): the stamp the gate compares, and
 *  when the compute began, for the scheduling readers (`slot-row-times.ts`). */
interface RowTimes {
  computed_at: string;
  compute_started_at: string;
}

/** `times` as a write names them, without the start when the column is missing. */
function timesFor(times: RowTimes, withStarted: boolean): Partial<RowTimes> & { computed_at: string } {
  return withStarted ? { ...times } : { computed_at: times.computed_at };
}

/** Where a write names the column, for the one line said if it is missing. */
const SLOT_WRITE = "slot row write";

/**
 * Mark every row stale after a settings save (#216, #3118), stamped from `nowMs`.
 *
 * Two columns, because back dating `computed_at` alone was not enough. A compute that
 * STARTED before the save read the old settings, and its stamp is newer than the epoch,
 * so the `computed_at` gate let it land over the stale mark; the row then looked fresh
 * for the whole freshness window while offering times under the old settings.
 * `invalidated_at` is the high water mark the write gate also checks, so a compute
 * that began at or before the save is refused and the row stays due.
 *
 * Every row is re-marked, including one already at the stale stamp: a second save
 * while the first is still draining makes a compute between the two just as wrong.
 * The filter matches every row and exists only because PostgREST refuses an UPDATE
 * with no filter at all. Returns the number of rows marked.
 */
export async function markSlotRowsInvalidated(db: SlotRowDb, nowMs: number): Promise<number> {
  const { data, error } = await db
    .from("bucket_slots")
    .update({ computed_at: STALE_STAMP, invalidated_at: new Date(nowMs).toISOString() })
    .gte("computed_at", STALE_STAMP)
    .select("bucket_code");
  if (error) throw new Error(`markSlotRowsInvalidated failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}

/** Epoch stamp that forces a row "due" for recompute (older than any freshness
 *  window). */
export const STALE_STAMP = "1970-01-01T00:00:00.000Z";

/** How many times a writer re-reads a row that changed under its compare and swap
 *  before it gives up and leaves the row to the next compute. */
const CAS_ATTEMPTS = 3;

export interface StoredSlotRow {
  payload: unknown;
  computed_at: string;
  invalidated_at: string | null;
}

/** One PK read of everything a refused or spliced write needs to decide. */
async function readRow(db: SlotRowDb, code: string): Promise<{ row: StoredSlotRow | null; error: unknown }> {
  // cap-safe: bucket_code is the primary key, so this is one row.
  const { data, error } = await db
    .from("bucket_slots")
    .select("payload, computed_at, invalidated_at")
    .eq("bucket_code", code)
    .maybeSingle();
  return { row: (data as StoredSlotRow | null) ?? null, error };
}

/**
 * The compare and swap both writers below use: the row is updated only while it
 * still holds the `computed_at`, `invalidated_at` and splice sequence it was read
 * with, so a compute, a save or another splice landing between the read and the
 * write sends the writer back to read again rather than overwriting it.
 */
async function swapRow(
  db: SlotRowDb,
  code: string,
  read: StoredSlotRow,
  /** A splice moves neither time; a full compute merged over a splice moves both. */
  values: { payload: unknown; times?: RowTimes },
): Promise<"swapped" | "changed" | "failed"> {
  const statement = (withStarted: boolean) => {
    let q = db
      .from("bucket_slots")
      .update({ payload: values.payload, ...(values.times ? timesFor(values.times, withStarted) : {}) })
      .eq("bucket_code", code)
      .eq("computed_at", read.computed_at);
    q = read.invalidated_at === null ? q.is("invalidated_at", null) : q.eq("invalidated_at", read.invalidated_at);
    const seq = spliceMetaOf(read.payload)?.seq;
    q = seq === undefined ? q.is("payload->splice->>seq", null) : q.eq("payload->splice->>seq", String(seq));
    return q.select("bucket_code");
  };
  const { data, error } = values.times
    ? await withStartedColumn(statement, SLOT_WRITE)
    : await statement(false);
  if (error) {
    log.warn("precompute", { msg: "slot row compare and swap failed", bucket: code }, error);
    return "failed";
  }
  return ((data ?? []) as unknown[]).length > 0 ? "swapped" : "changed";
}

/**
 * Settles a write the gated update refused (#3118, #3324), by reading the row that
 * stood. Three of the answers were always here: a save invalidated the row after this
 * compute began, a fresher compute already stands, or the reason cannot be read.
 *
 * The fourth is the booking fence. A booking spliced its window into this row after
 * this compute began, so this compute may not have seen it. It still lands, because
 * everything outside the window is newer than the row; inside the window it keeps a
 * time only where the row (which saw the booking) agrees. Refusing it instead would
 * starve the recompute lane under load (#3324). Only reached on a refused write, so
 * the extra read is paid only when there is something to settle.
 */
async function settleRefused(
  db: SlotRowDb,
  code: string,
  payload: unknown,
  computedAtMs: number,
  times: RowTimes,
): Promise<SlotRowWriteOutcome> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const { row, error } = await readRow(db, code);
    const invalidatedMs = row?.invalidated_at ? Date.parse(row.invalidated_at) : Number.NaN;
    const storedMs = row ? Date.parse(row.computed_at) : Number.NaN;
    if (error || !row || !Number.isFinite(storedMs)) break;
    if (Number.isFinite(invalidatedMs) && invalidatedMs >= computedAtMs) return "invalidated";
    if (storedMs >= computedAtMs) return "kept-newer";
    if (freshFences(spliceMetaOf(row.payload), computedAtMs).length === 0) {
      // Nothing explains the refusal any more: the row changed between the update and
      // this read. Try the plain gated update again.
      const again = await gatedUpdate(db, code, payload, times);
      if (again !== "no-row") return again;
      continue;
    }
    const merged = mergeFreshSplices(payload as SlotLists, row.payload, computedAtMs);
    const swapped = await swapRow(db, code, row, { payload: merged, times });
    if (swapped === "failed") return "failed";
    if (swapped === "swapped") {
      log.info("precompute", { msg: "merged a compute with a booking spliced after it began", bucket: code });
      return "written";
    }
  }
  log.warn("precompute", { msg: "slot row refused for a reason that could not be read", bucket: code });
  return "failed";
}

/** The gated overwrite. `no-row` means it matched nothing, which the caller resolves;
 *  it is deliberately NOT reported as a failure, because it is the normal answer both
 *  for a bucket with no row and for one whose row is fresher. */
async function gatedUpdate(
  db: SlotRowDb,
  code: string,
  payload: unknown,
  times: RowTimes,
): Promise<SlotRowWriteOutcome | "no-row"> {
  // The gate compares the STAMP only (#3388): a row built from fresher data wins
  // whenever its compute happened to start.
  const computedAt = times.computed_at;
  const statement = (withStarted: boolean) =>
    db
      .from("bucket_slots")
      .update({ payload, ...timesFor(times, withStarted) })
      .eq("bucket_code", code)
      .lt("computed_at", computedAt)
      // #3118: no save has invalidated the row since this compute began, and #3324: no
      // booking has been spliced into it since then either. Both strictly before, so a
      // compute starting at either instant is refused too. One `or` of four `and`s,
      // because two `or` parameters on one request is not a shape to rely on. The fence
      // is a json path, compared as text, which is why it is always an ISO stamp.
      .or(
        [
          `and(invalidated_at.is.null,${FENCE_PATH}.is.null)`,
          `and(invalidated_at.is.null,${FENCE_PATH}.lt.${computedAt})`,
          `and(invalidated_at.lt.${computedAt},${FENCE_PATH}.is.null)`,
          `and(invalidated_at.lt.${computedAt},${FENCE_PATH}.lt.${computedAt})`,
        ].join(","),
      )
      .select("bucket_code");
  const { data, error } = await withStartedColumn(statement, SLOT_WRITE);
  if (error) {
    log.warn("precompute", { msg: "slot row update failed", bucket: code }, error);
    return "failed";
  }
  return ((data ?? []) as unknown[]).length > 0 ? "written" : "no-row";
}

/** Where a spliced row keeps its newest booking fence (see `SpliceMeta`). */
export const FENCE_PATH = "payload->splice->>fenceAt";

/** What a splice did. `recompute` means its answer may predate something that has
 *  landed since (a settings save, or another booking overlapping its window), so the
 *  caller computes the window again rather than splicing a stale answer in.
 *  `unchanged` means the splice changed nothing this row offers, so nothing was
 *  written (#3324 review: a write per code is the part of a splice that scales). */
export type SpliceRowOutcome = "spliced" | "unchanged" | "no-row" | "recompute" | "failed";

/**
 * Splice one booked window into a row ALREADY READ (#3324), so a booking touching
 * many codes reads them all in one statement and only writes per code. Answers
 * `changed` when the row moved since that read; the caller then reads it afresh
 * through `spliceSlotRow`.
 *
 * A splice that changes nothing is not written. Its only other effect would be the
 * fence, and the fence protects what a splice changed: with nothing changed, the row
 * already agrees with the fresh answer inside every window. (The one residue: a row
 * that was already missing a time a stale writer would add back, a full compute that
 * began before a booking or, since #3334, a move's re-offer computed before one. That
 * time was free when that writer began, verify on book re-checks it live, and the
 * next compute past the booking corrects it.)
 *
 * A move passes two windows (#3334): the one it took and the one it left. Both land
 * in one compare and swap, a fresh fence overlapping EITHER sends it back to compute
 * again, and each window gets a fence of its own.
 */
export async function spliceFromRead(
  db: SlotRowDb,
  code: string,
  row: StoredSlotRow,
  parts: SplicePart[],
  fenceAtMs: number,
  computeStartedMs: number,
): Promise<SpliceRowOutcome | "changed"> {
  const p = row.payload as (Record<string, unknown> & SlotLists) | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.slots)) return "no-row";
  if (parts.length === 0) return "unchanged";
  const invalidatedMs = row.invalidated_at ? Date.parse(row.invalidated_at) : Number.NaN;
  if (Number.isFinite(invalidatedMs) && invalidatedMs >= computeStartedMs) return "recompute";
  const fresh = freshFences(spliceMetaOf(p), computeStartedMs);
  if (fresh.some((f) => parts.some((part) => windowsOverlap(f, part.w)))) return "recompute";
  // parse-ok: an unreadable stamp keeps every fence (0 drops none), the safe direction.
  const storedMs = Date.parse(row.computed_at);
  const next = splicePayload(p, parts, fenceAtMs, Number.isFinite(storedMs) ? storedMs : 0);
  // Compared by content, not length: a move's freed window can put a time back
  // while its taken window drops one (#3334).
  const unchanged =
    sameList(next.slots, p.slots) &&
    sameList(next.slotsWithoutLow ?? [], Array.isArray(p.slotsWithoutLow) ? p.slotsWithoutLow : []);
  if (unchanged) return "unchanged";
  const swapped = await swapRow(db, code, row, { payload: next });
  return swapped === "swapped" ? "spliced" : swapped;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Every listed code's row in ONE read (#3324 review), keyed by code. A code with
 *  no row is absent. Throws on a read error, which is "could not tell", never "no
 *  rows": the caller counts every code as failed and the lane covers them. */
export async function readSlotRows(db: SlotRowDb, codes: string[]): Promise<Map<string, StoredSlotRow>> {
  const out = new Map<string, StoredSlotRow>();
  if (codes.length === 0) return out;
  // cap-safe: bucket_code is the primary key and the list is one advisor's codes (at most the roster's sixty odd).
  const { data, error } = await db
    .from("bucket_slots")
    .select("bucket_code, payload, computed_at, invalidated_at")
    .in("bucket_code", codes);
  if (error) throw new Error(`bucket_slots read for a splice failed: ${error.message}`);
  for (const r of (data ?? []) as (StoredSlotRow & { bucket_code: string })[]) out.set(r.bucket_code, r);
  return out;
}

/**
 * Splice one booked window into a stored row (#3324), WITHOUT moving `computed_at`:
 * the rest of the row is exactly as old as it was, and the freshness floor (the lane
 * and the stale alarm) has to go on seeing that.
 *
 * `fenceAtMs` is when the booking's busy block had committed; it is recorded in the
 * row so an older full compute landing later keeps the booking (see `settleRefused`).
 * `computeStartedMs` is when the splice's own reads began, so a booking fenced at or
 * after it, overlapping this window, sends the splice back to compute again.
 *
 * Never creates a row: a code with none is offering nothing yet, and the lane builds
 * it. A row that keeps changing under the compare and swap is given up on after a
 * few attempts and left to the lane, unchanged.
 */
export async function spliceSlotRow(
  db: SlotRowDb,
  code: string,
  parts: SplicePart[],
  fenceAtMs: number,
  computeStartedMs: number,
): Promise<SpliceRowOutcome> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const { row, error } = await readRow(db, code);
    if (error) {
      log.warn("precompute", { msg: "slot row read for a splice failed", bucket: code }, error);
      return "failed";
    }
    if (!row) return "no-row";
    const result = await spliceFromRead(db, code, row, parts, fenceAtMs, computeStartedMs);
    if (result !== "changed") return result;
  }
  log.warn("precompute", { msg: "slot row kept changing under a splice; left to the lane", bucket: code });
  return "failed";
}
