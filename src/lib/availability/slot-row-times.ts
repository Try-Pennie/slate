/**
 * The two times a `bucket_slots` row carries, and which question each answers (#3388).
 *
 *   - `computed_at`, the STAMP: the oldest state the slots were computed from. For
 *     a live compute that is when it started (#1048); for the recompute lane it is
 *     when its cached eligibility list was read, if that was earlier. The write gate
 *     compares it, so a row built from fresher data always wins, and anything that
 *     measures how old the DATA is reads it.
 *   - `compute_started_at`, the START (migration 0202): when the compute that wrote
 *     the row began. Anything that judges whether the lane is keeping up, and so
 *     when a row is next DUE, reads it through `scheduleAnchorMs`. Judged by the
 *     stamp, a cached read moved a pool back past its grid point and the lane
 *     recomputed it a tick later instead of a window later.
 *
 * Code ships before its migration is applied for a few minutes at most (the deploy
 * gate refuses a merge while a migration is pending), so every read and write that
 * names the new column falls back to the stamp alone when the database answers that
 * the column does not exist, and remembers that for the isolate.
 *
 * No `@/` imports, so the node suite can drive it directly.
 */
import { log } from "../log.ts";
import { parseStampMs } from "../date/stamp.ts";
import { ELIGIBLE_TTL_SECONDS } from "./eligible-cache-key.ts";
import type { SlotRowDb } from "./slot-row-write.ts";

export const COMPUTE_STARTED_COLUMN = "compute_started_at";

/**
 * The most a row's stamp can legitimately sit before its compute's start: the
 * eligibility cache's own lifetime, which `readEligibleCached` enforces on every
 * hit. Not a second tunable: a cached list older than this is never used.
 */
export const MAX_STAMP_LAG_MS = ELIGIBLE_TTL_SECONDS * 1000;

/**
 * The instant a row's NEXT recompute is scheduled from, and the stale alarm judged
 * from: the compute's start when the row records one the stamp can explain,
 * otherwise the stamp.
 *
 * "Can explain" is a start no earlier than the stamp and no more than one cache
 * lifetime after it, because that is the only gap a cached read can open. Anything
 * else means the stamp was moved on its own, and the stamp wins:
 *   - a settings save, or the runbook's hand SQL, back dates the stamp to the epoch
 *     to force every row due and leaves the start alone (#216, #3118);
 *   - an unreadable stamp is read as 0 so it pages (#1169);
 *   - a writer that did not record a start leaves an older one behind;
 *   - no start at all: a row from before migration 0202, or the column missing.
 */
export function scheduleAnchorMs(computedAtMs: number, startedAtMs: number | null | undefined): number {
  if (startedAtMs === null || startedAtMs === undefined || !Number.isFinite(startedAtMs)) return computedAtMs;
  const lag = startedAtMs - computedAtMs;
  return lag >= 0 && lag <= MAX_STAMP_LAG_MS ? startedAtMs : computedAtMs;
}

/** Whether this isolate has found `bucket_slots` without migration 0202's column. */
let startedColumnMissing = false;

export function startedColumnAbsent(): boolean {
  return startedColumnMissing;
}

/** Record that the column is missing; answers whether this is the first time. */
export function markStartedColumnAbsent(): boolean {
  const first = !startedColumnMissing;
  startedColumnMissing = true;
  return first;
}

/** For tests: forget a previous finding. */
export function resetStartedColumnProbe(): void {
  startedColumnMissing = false;
}

/**
 * Whether a database error says `compute_started_at` does not exist. A read naming
 * it answers Postgres's undefined column (42703); a write naming it answers
 * PostgREST's unknown column (PGRST204). The message must name the column, so an
 * unrelated undefined column is never mistaken for this one and silently retried.
 */
export function isMissingStartedColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (code === "42703" || code === "PGRST204") &&
    typeof message === "string" &&
    message.includes(COMPUTE_STARTED_COLUMN)
  );
}

/**
 * Run a statement that names the column, and once more without it if the database
 * says the column is missing. `run(true)` includes the column. After the first
 * miss in an isolate, statements go straight to `run(false)`.
 *
 * The first miss in an isolate is said once, naming `where`: code running ahead of
 * migration 0202 writes and reads the stamp alone, and the lane schedules from the
 * stamp as it did before #3388. Any other error is returned untouched.
 */
export async function withStartedColumn<R extends { error: unknown }>(
  run: (includeStarted: boolean) => PromiseLike<R>,
  where: string,
): Promise<R> {
  if (startedColumnMissing) return run(false);
  const first = await run(true);
  if (!isMissingStartedColumn(first.error)) return first;
  if (markStartedColumnAbsent()) {
    log.warn("precompute", {
      msg: `bucket_slots has no ${COMPUTE_STARTED_COLUMN} (0202 not applied); rows are scheduled from their stamp`,
      where,
    });
  }
  return run(false);
}

/** One stored row's times, as the lane's scheduling reads them. */
export interface KnownSlotRowTimes {
  code: string;
  /** The stamp; 0 when it cannot be read (#1169: ancient, so due and paged). */
  computedAtMs: number;
  /** The compute's start; null when the row has none or it cannot be read. */
  startedAtMs: number | null;
}

/**
 * Every stored row's two times, for the due set and the stale alarm. Throws on a
 * read error, which is "could not tell", never "no rows". A database without
 * migration 0202's column is read for the stamp alone.
 */
export async function readKnownSlotRows(db: SlotRowDb): Promise<KnownSlotRowTimes[]> {
  const { data, error } = await withStartedColumn(
    (withStarted) =>
      db
        .from("bucket_slots")
        .select(withStarted ? `bucket_code, computed_at, ${COMPUTE_STARTED_COLUMN}` : "bucket_code, computed_at"),
    "known slot rows",
  );
  if (error) throw new Error(`read failed [listKnownBucketSlotRows]: ${error.message}`);
  const rows = (data ?? []) as unknown as {
    bucket_code: string;
    computed_at: string;
    compute_started_at?: string | null;
  }[];
  return rows.map((row) => ({
    code: row.bucket_code,
    computedAtMs: parseStampMs(row.computed_at) ?? 0,
    startedAtMs: parseStampMs(row.compute_started_at ?? null),
  }));
}
