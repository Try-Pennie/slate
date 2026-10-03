import { log } from "../log.ts";
import type { supabaseAdmin } from "@/lib/supabase/admin";

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
  payload: unknown,
  computedAtMs: number,
): Promise<SlotRowWriteOutcome> {
  const computedAt = new Date(computedAtMs).toISOString();

  const first = await gatedUpdate(db, code, payload, computedAt);
  if (first !== "no-row") return first;

  // Nothing older to overwrite. Either the bucket has no row at all, or the row that
  // is there is at least as fresh as this compute. The insert tells us which.
  const { error } = await db
    .from("bucket_slots")
    .insert({ bucket_code: code, payload, computed_at: computedAt });
  if (!error) return "written";
  if (error.code !== UNIQUE_VIOLATION) {
    log.warn("precompute", { msg: "slot row insert failed", bucket: code }, error);
    return "failed";
  }

  // A row exists. Re-run the gate: if it is older than this compute (a create race we
  // lost while holding newer data), overwrite it; otherwise it is genuinely fresher,
  // or a save invalidated it after this compute began, and it stands.
  const second = await gatedUpdate(db, code, payload, computedAt);
  return second === "no-row" ? whyRefused(db, code, computedAtMs) : second;
}

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

/**
 * Says WHY a write was refused, by reading the row that stood (#3118). Only reached on
 * the rare refused path, so the one PK read is cheap. A row this cannot judge is a
 * failure rather than a guess at either reason.
 */
async function whyRefused(
  db: SlotRowDb,
  code: string,
  computedAtMs: number,
): Promise<SlotRowWriteOutcome> {
  // cap-safe: bucket_code is the primary key, so this is one row.
  const { data, error } = await db
    .from("bucket_slots")
    .select("computed_at, invalidated_at")
    .eq("bucket_code", code)
    .maybeSingle();
  const row = data as { computed_at: string; invalidated_at: string | null } | null;
  const invalidatedMs = row?.invalidated_at ? Date.parse(row.invalidated_at) : Number.NaN;
  if (!error && Number.isFinite(invalidatedMs) && invalidatedMs >= computedAtMs) return "invalidated";
  const computedMs = row ? Date.parse(row.computed_at) : Number.NaN;
  if (!error && Number.isFinite(computedMs) && computedMs >= computedAtMs) return "kept-newer";
  log.warn("precompute", { msg: "slot row refused for a reason that could not be read", bucket: code }, error ?? undefined);
  return "failed";
}

/** The gated overwrite. `no-row` means it matched nothing, which the caller resolves;
 *  it is deliberately NOT reported as a failure, because it is the normal answer both
 *  for a bucket with no row and for one whose row is fresher. */
async function gatedUpdate(
  db: SlotRowDb,
  code: string,
  payload: unknown,
  computedAt: string,
): Promise<SlotRowWriteOutcome | "no-row"> {
  const { data, error } = await db
    .from("bucket_slots")
    .update({ payload, computed_at: computedAt })
    .eq("bucket_code", code)
    .lt("computed_at", computedAt)
    // #3118: and no save has invalidated the row since this compute began. Strictly
    // before, so a compute starting at the save instant is refused too.
    .or(`invalidated_at.is.null,invalidated_at.lt.${computedAt}`)
    .select("bucket_code");
  if (error) {
    log.warn("precompute", { msg: "slot row update failed", bucket: code }, error);
    return "failed";
  }
  return ((data ?? []) as unknown[]).length > 0 ? "written" : "no-row";
}
