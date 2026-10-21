import { getBucketSlots, loadBucketSlotInputs, type EligibleResolver } from "./service";
import { slotCacheEntryKey, slotCacheKey } from "./cache-key";
import {
  resolveBucketSlots,
  SUPERSEDED_BY_SAVE,
  COLD_WRITER,
  type ReadDeps,
  type CachedBucketSlots,
  type ResolvedBucketSlots,
} from "./precompute-core";
import {
  readBucketSlotsRow,
  storeBucketSlotsRow,
  recomputeBucketSlots,
  computeBucketSlotsForWindow,
  bucketsForAgent,
  listPoolBuckets,
  touchedBucketCodes,
} from "./precompute";
import {
  recomputePool,
  recomputeTouchedPools,
  type TouchedPoolsOutcome,
  type PooledBucket,
} from "./pool-recompute";
import { SlotRowRefused } from "./slot-row-write";
import { joinWriters, type SlotRowWriter, type WrittenBy } from "./slot-row-writer";
import { bookedSpliceIo } from "./booked-splice-io";
import { spliceBookedTime, type BookedTime, type BookedSpliceOutcome } from "./booked-splice";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { groupByPool } from "./pool-key";
import { groupingEntriesOf } from "@/lib/booking/pool-grouping";
import { makeGroupingStore, POOL_GROUPING_FRESH_MS } from "@/lib/booking/pool-grouping-reader";
import { publishPoolGroupingAfterResponse } from "@/lib/booking/pool-grouping-live";
import { makePoolRefreshCoalescer, POST_CONFIRM_REFRESH_WINDOW_MS } from "./pool-refresh-coalescer";
import { appUrl } from "@/lib/env";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { loadOfferedOpenDaysCached } from "@/lib/booking/days-offered-load";
import { selectWithTierFallback } from "@/lib/routing/tier-fallback";
import { tierKeyOf } from "@/lib/routing/tiers";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import { SERVER_TIMING_NAMES, type SpanTimer } from "@/lib/api/server-timing";
// The window and the served slot rule are shared with the bucket availability
// page, which has to say what this function produces (2026-10-02).
import { offeredWindowEndFor, servedSlotsForRung } from "./offered-window";

// Short L1 TTL: the precompute row is the source of truth, so the Cache API is
// just a per-colo accelerator. 5s keeps a far-colo read self-healing well inside
// the <5s display-freshness target.
export const SLOT_TTL_SECONDS = 5;
// Real booking window is 0-3 days, so a 4-day horizon covers it with margin.
export const HORIZON_DAYS = 4;

// `caches.default` is a Cloudflare runtime extension not in the standard lib types.
type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
};
function slotCache(): CfCache | null {
  return (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null;
}

// Lookup-only key Request on the app's own zone (not a real route).
function keyRequest(key: string): Request {
  return new Request(`${appUrl()}/__slot-cache/${encodeURIComponent(key)}`);
}

/**
 * Read path for the embed: Cache API -> precomputed `bucket_slots` row -> bounded
 * fail-open compute. The multi-agent compute runs ONLY when no good row exists
 * (new/never-computed bucket); the steady state is a warm cache hit or one
 * indexed PK read. Orchestration + the "never compute when a good row exists"
 * invariant are unit-tested in precompute-core.ts; here we only bind real IO.
 */
export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
  // #3713: when given, each read below is recorded under its own Server-Timing name.
  // The route passes one for the requested bucket only; see getBucketSlotsWithFallback.
  timing?: SpanTimer,
): Promise<ResolvedBucketSlots | null> {
  const cache = slotCache();
  const timed = spanOrRun(timing);
  const deps: ReadDeps = {
    cacheGet: (key) =>
      timed(SERVER_TIMING_NAMES.cache, async () => {
        if (!cache) return null;
        try {
          const hit = await cache.match(keyRequest(key));
          if (hit) return JSON.parse(await hit.text()) as CachedBucketSlots;
        } catch { /* fall through */ }
        return null;
      }),
    cachePut: (key, val) =>
      timed(SERVER_TIMING_NAMES.cache, async () => {
        if (!cache) return;
        try {
          await cache.put(
            keyRequest(key),
            new Response(JSON.stringify(val), {
              headers: {
                "content-type": "application/json",
                "cache-control": `public, max-age=${SLOT_TTL_SECONDS}`,
              },
            }),
          );
        } catch { /* ignore */ }
      }),
    readRow: (c) => timed(SERVER_TIMING_NAMES.row, () => readBucketSlotsRow(c)),
    nowMs: () => Date.now(),
    compute: (c, from, to) => timed(SERVER_TIMING_NAMES.compute, () => getBucketSlots(c, from, to)),
    // #3118: a write a settings save superseded is answered as such, so the read
    // redoes the compute rather than serving and caching slots from the old settings.
    // A refused row still throws (#3119) and reaches writeFailed below.
    writeRow: (c, val, computedAtMs) =>
      timed(SERVER_TIMING_NAMES.compute, async () => {
        const outcome = await storeBucketSlotsRow(c, val, computedAtMs, COLD_WRITER);
        if (outcome === "failed") throw new SlotRowRefused(c);
        if (outcome === "invalidated") return SUPERSEDED_BY_SAVE;
        return new Date(computedAtMs).toISOString();
      }),
    // #3119: the lead is still served what was computed; the row it could not store
    // is said here, and the next request or the cron backstop computes it again.
    writeFailed: (c, err) =>
      log.warn("slot-cache", { msg: "self-heal slot row not stored", bucket: c }, err),
    // #1296: the CURRENT org hours, so a narrowing filters the cached slots on the
    // very next request rather than waiting for a recompute. One read per isolate
    // per SLOT_TTL_SECONDS; a failed refresh serves the last known week.
    businessHours: () => timed(SERVER_TIMING_NAMES.hours, loadBusinessHoursCached),
  };
  // #3381: `fromIso` no longer reaches the read: the key never depended on it (#3366)
  // and the cold compute now anchors on now, as every recompute does.
  return resolveBucketSlots(code, horizonDays, deps);
}

/** Record `fn` under `name` when a timer was given, otherwise just run it. */
function spanOrRun(timing: SpanTimer | undefined) {
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => (timing ? timing.span(name, fn) : fn());
}

// Best-effort per-isolate dedupe: collapse a burst of recompute requests for the
// same bucket (e.g. a flurry of Google pushes) into at most one every 2s. The
// cron backstop guarantees freshness regardless, so a skipped recompute is safe.
const RECOMPUTE_SKIP_MS = 2000;
const lastRecomputeAt = new Map<string, number>();

/**
 * Refresh a bucket's precomputed row over the org-wide horizon, then clear its L1
 * cache key so the next read serves the fresh row. Called by the refresh-on-change
 * writers (booking / Google sync / OOO), the cron backstop, and the admin
 * horizon-save (#216). Debounced per bucket; pass force=true (the cron) to bypass.
 *
 * The COMPUTE WINDOW tracks the runtime horizon (#216) so raising the horizon makes
 * rows actually span more days and lowering it bounds them. The L1 cache KEY stays
 * on the fixed `HORIZON_DAYS` namespace so it always matches what the read path
 * (which never reads the setting, keeping the hot path DB-free) looks up and
 * invalidates. Pass `horizonDays` to avoid a per-call settings read when a caller
 * loops over many buckets and has already loaded it once; omitted, it self-loads
 * (a missed thread is a harmless extra read, never a wrong window).
 */
export async function recomputeBucketSlotsForToday(
  code: string,
  /** Which path is refreshing it (#3381), stamped on the row it writes. */
  writtenBy: WrittenBy,
  force = false,
  resolveEligible?: EligibleResolver,
  horizonDays?: number,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastRecomputeAt.get(code) ?? 0) < RECOMPUTE_SKIP_MS) return;
  lastRecomputeAt.set(code, now);

  const nowIso = new Date().toISOString();
  const horizon = horizonDays ?? (await loadBookingHorizonDays());
  const { fromIso, toIso } = slotCacheKey(code, nowIso, horizon);
  // L1 key on the fixed namespace so read/invalidate always agree. It carries no
  // day (#3366), so this drops the entry every reader wrote, whatever `from` they sent.
  const key = slotCacheEntryKey(code, HORIZON_DAYS);
  // The horizon is a count of BOOKABLE days (#1326), so it is passed through as the
  // trim target rather than being implied by the window, which is deliberately wider.
  // A refused row now THROWS (#3119) and reaches the caller's failure path. The L1
  // entry is still dropped first, as the pooled path does: a stale entry must never
  // outlive the attempt, and the read behind it falls through to the stored row.
  try {
    await recomputeBucketSlots(code, fromIso, toIso, writtenBy, resolveEligible, horizon);
  } finally {
    const cache = slotCache();
    if (cache) {
      try { await cache.delete(keyRequest(key)); } catch { /* ignore */ }
    }
  }
}

/**
 * Refresh a whole POOL over the org-wide horizon: one availability compute,
 * written to every bucket code in the pool, each with its own identity (#2245).
 * Returns how many codes were actually stored.
 *
 * This is what the every minute lane dispatches. Sixty codes resolve to fifteen
 * pools, so the lane was running the compute sixty times for fifteen answers, on
 * the lane whose headroom already pages (#2021).
 *
 * Deliberately NOT debounced. The per code entry point above collapses a burst of
 * pushes for one bucket; this one is only ever called by the cron with force, and
 * a second debounce keyed on the pool would silently skip a due pool.
 *
 * The window does not depend on which code computes it: `slotCacheKey` anchors
 * `from` to the start of the UTC day and derives `to` from the horizon alone, so
 * the representative's code decides nothing about the answer.
 */
export async function recomputePoolSlotsForToday(
  pool: PooledBucket[],
  /** Which path is refreshing it (#3381), stamped on every row it writes. */
  writtenBy: WrittenBy,
  resolveEligible?: EligibleResolver,
  horizonDays?: number,
): Promise<number> {
  const representative = pool[0];
  if (!representative) return 0;
  const nowIso = new Date().toISOString();
  const horizon = horizonDays ?? (await loadBookingHorizonDays());
  const { fromIso, toIso } = slotCacheKey(representative.code, nowIso, horizon);

  const outcome = await recomputePool(pool, {
    nowMs: Date.now,
    compute: (code) =>
      computeBucketSlotsForWindow(code, fromIso, toIso, resolveEligible, horizon),
    writeRow: (code, val, computedAtMs) => storeBucketSlotsRow(code, val, computedAtMs, writtenBy),
    // The L1 key is on the fixed HORIZON_DAYS namespace, the same one the read
    // path looks up, so read and invalidate always agree.
    invalidate: (code) => invalidateBucketSlots(code),
  });

  if (outcome.failed.length > 0) {
    // Counted out loud rather than swallowed: these codes keep serving their
    // previous row, so the only other trace would be the stale alarm minutes later.
    log.warn("slot-cache", {
      msg: "pooled slot write failed for some codes",
      pool: representative.code,
      codes: outcome.failed.join(","),
    });
  }
  return outcome.written.length;
}

/**
 * How long an agent's pool refresh may keep STARTING pools (#2922). It runs after
 * the response, where Cloudflare cancels whatever is still going 30 seconds after
 * the response ends, and on the push path the calendar sync spends a few of those
 * seconds first. A pool takes about four seconds, so twenty leaves room for the
 * last one started to finish; anything not started is left to the every minute
 * lane rather than being cut off mid write.
 */
export const AGENT_RECOMPUTE_BUDGET_MS = 20_000;

/** When each pool was last started in this isolate, for the burst debounce. */
const lastPoolRecomputeAt = new Map<string, number>();

/**
 * The refresh every confirmed booking schedules after its response (#3258), per
 * POOL and coalesced: see `pool-refresh-coalescer.ts` for the rule and the load run
 * that measured why. It shares `lastPoolRecomputeAt` with the push path, so the two
 * never compute one pool back to back.
 */
const poolRefreshes = makePoolRefreshCoalescer<SlotRowWriter>({
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  windowMs: POST_CONFIRM_REFRESH_WINDOW_MS,
  lastStartedAt: lastPoolRecomputeAt,
});

/** The reads only arm's own start times: named so the test reset can clear it. */
const lastPoolReadAt = new Map<string, number>();

/**
 * The load run's reads only arm, coalesced by the SAME rule so the arms stay
 * comparable (#3293 review), on its own start map: a read that recorded itself in
 * `lastPoolRecomputeAt` would debounce a real recompute on the push path.
 */
const bookingReads = makePoolRefreshCoalescer<SlotRowWriter>({
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  windowMs: POST_CONFIRM_REFRESH_WINDOW_MS,
  lastStartedAt: lastPoolReadAt,
});

/**
 * Which pool a code is in, from a grouping read at most once a minute per isolate.
 * It only decides which bookings SHARE a refresh; the refresh itself re-reads the
 * buckets, so a bucket edited in the last minute is computed from what it is now.
 *
 * A code the cached grouping does not know (a bucket created inside the minute) is
 * re-read once, and if still unknown is remembered as missing for the rest of the
 * cache's minute and coalesced on its own key: never skipped, because the refresh
 * resolves its pool fresh when it runs, and never a re-read per booking (#3293
 * review).
 *
 * Why a STALE key is harmless (#3293 review). The key decides only which bookings
 * share a refresh and when; what gets refreshed is resolved from the live buckets
 * for every joined code (`forPoolsOf`). If a bucket changed pools inside the minute:
 * two bookings of one live pool may hold different keys, which costs a second
 * compute (possibly beside the first, which the compare and swap row write makes
 * safe, #1048); and bookings of different live pools may share a key, which
 * refreshes all of their live pools in one run. Neither can leave a booked time
 * unrefreshed, and both last only until the cache's minute is up.
 */
let poolKeyCache: { readAtMs: number; byCode: Map<string, string>; missing: Set<string> } | null = null;
/** One minute, the same window a published snapshot stands for (#3460), so the two cannot drift. */
const POOL_KEY_CACHE_MS = POOL_GROUPING_FRESH_MS;

/**
 * The grouping the CONFIRM LINE keys on (#3325, #3460): each code's pool digest, from
 * this server's own read or from the snapshot the recompute lane published, whichever
 * was read more recently (compare and set, `makeGroupingStore`). Kept apart from
 * `poolKeyCache` above on purpose: that one holds full pool keys for the refresh
 * coalescer, whose start times the push path shares (`lastPoolRecomputeAt`), and a
 * snapshot carries only digests. The confirm line's reader installs into it
 * (`confirm-line-live.ts`); nothing here fetches.
 */
export const lineGroupingStore = makeGroupingStore({ now: () => Date.now(), freshMs: POOL_GROUPING_FRESH_MS });

async function readPoolKeys(now: number): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  const groups = groupByPool(await listPoolBuckets());
  for (const [key, members] of groups) {
    for (const m of members) byCode.set(m.code, key);
  }
  poolKeyCache = { readAtMs: now, byCode, missing: new Set() };
  // #3460: the same read keys the confirm line, under the time the read STARTED, and
  // never over a newer snapshot that landed while it was reading. An empty read installs
  // and publishes nothing: every code would read as a gap.
  const entries = groupingEntriesOf(groups);
  if (entries.length > 0) {
    lineGroupingStore.install(entries, now, "read");
    // The backup to the recompute lane's publish: any server that read the grouping
    // offers it to the others, after the response.
    publishPoolGroupingAfterResponse(entries, now);
  }
  return byCode;
}

/**
 * The pool a code is in, as this server holds it: its pool's digest, null for a code
 * with no bucket, or undefined when no fresh grouping is held. A look, never a read.
 * The confirm path makes sure a fresh grouping is held, when it can, BEFORE it keys its
 * line: it waits, within a short bound, for the snapshot the recompute lane published
 * (#3460, superseding #3355 items 1 and 2). `warmPoolKeys`, scheduled after the
 * response, is the fallback for a server that could not get one.
 */
export function peekPoolKey(code: string): string | null | undefined {
  return lineGroupingStore.peek(code);
}

let warmingPoolKeys: Promise<void> | null = null;

/**
 * Refresh the grouping when no fresh one is held, at most one read at a time however
 * many confirms ask (#3325). A fresh snapshot counts as held, so a server the snapshot
 * reached does not pay the two table reads (#3460). A failed read REJECTS and leaves the
 * grouping as it was, so a code reads as unknown rather than as having no pool.
 */
export function warmPoolKeys(): Promise<void> {
  if (lineGroupingStore.fresh()) return Promise.resolve();
  warmingPoolKeys ??= readPoolKeys(Date.now())
    .then(() => undefined)
    .finally(() => {
      warmingPoolKeys = null;
    });
  return warmingPoolKeys;
}

async function poolKeyOfCode(code: string): Promise<string> {
  const now = Date.now();
  const fresh = !poolKeyCache || now - poolKeyCache.readAtMs > POOL_KEY_CACHE_MS;
  let byCode = fresh ? await readPoolKeys(now) : poolKeyCache!.byCode;
  if (!byCode.has(code) && !fresh && !poolKeyCache!.missing.has(code)) byCode = await readPoolKeys(now);
  const key = byCode.get(code);
  if (key !== undefined) return key;
  poolKeyCache!.missing.add(code);
  return `code:${code}`;
}

/**
 * Run `act` once for every pool holding any of `codes`, resolved from the buckets as
 * they are NOW. Every pool is attempted even when one fails, and the failures are
 * thrown together afterwards, so one bad pool cannot cost another its refresh.
 */
async function forPoolsOf(
  codes: string[],
  act: (pool: PooledBucket[], horizon: number) => Promise<void>,
): Promise<void> {
  const [buckets, horizon] = await Promise.all([listPoolBuckets(), loadBookingHorizonDays()]);
  const groups = [...groupByPool(buckets).values()];
  const homeless = codes.filter((code) => !groups.some((members) => members.some((m) => m.code === code)));
  for (const code of homeless) {
    log.warn("slot-cache", { msg: "booked code is in no pool, so nothing was refreshed", bucket: code });
  }
  // #3293 review: a refresh that could refresh NOTHING failed, and says so, so the
  // deferred job records a failure rather than a refresh that never happened.
  if (homeless.length === codes.length) {
    throw new Error(`no pool holds booked code ${codes.join(", ")}, so nothing was refreshed`);
  }
  const failures: string[] = [];
  for (const pool of groups.filter((members) => members.some((m) => codes.includes(m.code)))) {
    try {
      await act(pool, horizon);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/** For tests: forget both coalescers, the pool key cache and both start maps. */
export function resetBookingRefreshesForTests(): void {
  poolRefreshes.reset();
  bookingReads.reset();
  poolKeyCache = null;
  lineGroupingStore.reset();
  lastPoolRecomputeAt.clear();
  lastPoolReadAt.clear();
  pushRotation.clear();
}

/**
 * Refresh the pool a code is in, so a stale time stops being offered, sharing one
 * compute with everything else refreshing that pool inside the window (#3258).
 * Resolves when the refresh covering it has finished, and REJECTS when a pool stored
 * no row, so the caller logs a failed job rather than a refresh that never landed; the
 * recompute lane backstops it.
 *
 * Two callers, one mechanism (L613): a confirmed booking, so the booked time stops
 * being offered (#2345, #2968); and a `candidate_read_empty` refusal whose stored row
 * was proven to still offer the refused instant (#3633, via `refusal-stored-offer.ts`).
 */
export async function refreshPoolOf(code: string, reason: "booking" | "refusal"): Promise<void> {
  const key = await poolKeyOfCode(code);
  await poolRefreshes.request(key, code, reason, recomputePoolsOf);
}

/** The refresh both the booking and the push paths share: one compute per pool, its
 *  rows naming every reason the coalesced refresh was asked for (#3381). */
const recomputePoolsOf = (codes: string[], reasons: SlotRowWriter[]): Promise<void> =>
  forPoolsOf(codes, async (pool, horizon) => {
    const stored = await recomputePoolSlotsForToday(pool, joinWriters(reasons), undefined, horizon);
    if (stored === 0) {
      throw new Error(
        `pool refresh for ${pool.map((b) => b.code).join("+")} stored no rows; the recompute lane will retry`,
      );
    }
  });

/**
 * Take a just booked time out of what EVERY pool the booked advisor serves is
 * offering (#3324), by re-judging only the window the booking can have changed and
 * splicing that into each code's row. See `booked-splice.ts` for the rule and
 * `slot-splice.ts` for the fence that keeps an older full compute from putting the
 * time back.
 *
 * It replaces `refreshPoolOf` for a confirmed booking, and since #3334 for
 * a reschedule or reassign too (`booked.freed`, the time the move left, goes back on
 * offer in every pool the old advisor serves): no whole pool compute, no coalescing
 * window to wait out, and the advisors' OTHER pools are covered too. The recompute
 * lane keeps doing full computes as the freshness floor.
 *
 * REJECTS when a code could not be spliced, so `afterResponse` logs the job as
 * failed rather than reporting a splice that never landed; the rows it could not
 * splice are exactly as they were, and the lane covers them.
 */
export async function spliceBookedTimeAfterBooking(code: string, booked: BookedTime): Promise<void> {
  // A failed roster read THROWS out of the plan (could not tell); an empty plan was
  // read successfully and means the advisor serves no pool now, most often because
  // they were made unbookable or deactivated after the booking. No pool routes to
  // them, so no row offers their time and there is nothing to splice: a logged skip,
  // never a failed job.
  const outcome = await spliceBookedTime(booked, bookedSpliceDeps(code));
  if (outcome.pools === 0) {
    log.info("slot-cache", {
      msg: "booked time splice skipped: the advisor serves no pool",
      bucket: code,
      user_id: booked.userId,
    });
    return;
  }
  log.info("slot-cache", { msg: "booked time spliced", bucket: code, user_id: booked.userId, ...outcome });
  if (outcome.failed > 0) {
    throw new Error(`${outcome.failed} code(s) could not be spliced after the booking on ${code}; the lane covers them`);
  }
}

/**
 * The load run's `reads-only` arm (#3258, #3324): exactly the reads the splice makes
 * for the same booking, the cap widening included, with no compute, no row write and
 * no edge cache drop, so it stays comparable with the `on` arm.
 */
export async function readSpliceInputsAfterBooking(code: string, booked: BookedTime): Promise<void> {
  await spliceBookedTime(booked, bookedSpliceDeps(code), { readsOnly: true });
}

/** The batched database reads and writes (`booked-splice-io.ts`), with this module's
 *  edge cache as the one thing a splice drops besides the row. */
function bookedSpliceDeps(bookedCode: string) {
  return { ...bookedSpliceIo(supabaseAdmin(), bookedCode), invalidate: invalidateBucketSlots };
}

export type { BookedTime, BookedSpliceOutcome };

/**
 * How many pools one Google push may refresh (#3258).
 *
 * Production, 2026-10-05: `POST /api/google/push` was about two thirds of the
 * Worker's CPU (2,208 a day at a p50 of 10.2s, about 2.5s a pool and four pools a
 * push), and every lead facing confirm timeout since 2026-10-04 overlapped one;
 * confirms overlapping 6s or more of push and cron CPU timed out over 10s 39
 * percent of the time against 4 percent under 1s. Two halves the measured push.
 *
 * The pools past it are left to the recompute lane, which refreshes every pool at
 * least once a `RECOMPUTE_FRESH_MS` (four minutes), with the stale alarm at six. So a
 * calendar change reaches the deferred pools' offered times within about four
 * minutes rather than seconds. Verify on book re-reads Google live at confirm, so an
 * over-offered time costs a lead "that time was just taken", never a double booking.
 * Before #2923 most push refreshes were cancelled outright (#2922 measured 90 percent
 * and more), so the lane was carrying this freshness for months already.
 */
export const MAX_PUSH_POOLS_PER_CALL = 2;

/**
 * Where each agent's next push starts in its sorted pools, so every pool gets its
 * turn. PER AGENT (#3302 advisory review): one counter shared by agents with
 * different pool counts steps each by however many other pushes came between, which
 * can pin an agent to the same pools forever. Bounded like the coalescer's keys: an
 * entry not used for `PUSH_ROTATION_IDLE_MS` is dropped, which only restarts that
 * agent's rotation, and the map never holds more than the agents pushing recently.
 */
const pushRotation = new Map<string, { next: number; usedAtMs: number }>();
const PUSH_ROTATION_IDLE_MS = 60 * 60_000;

function nextRotation(userId: string, nowMs: number): number {
  for (const [id, r] of pushRotation) {
    if (nowMs - r.usedAtMs > PUSH_ROTATION_IDLE_MS) pushRotation.delete(id);
  }
  const r = pushRotation.get(userId) ?? { next: 0, usedAtMs: nowMs };
  pushRotation.set(userId, { next: r.next + 1, usedAtMs: nowMs });
  return r.next;
}

/**
 * Refresh the pools an agent's calendar change affects, after a Google push (#2922,
 * #3258): through the SAME per pool coalescer and window as the booking refresh, so
 * a pool a booking or another push refreshed a moment ago is not computed again
 * beside it, and at most `MAX_PUSH_POOLS_PER_CALL` pools per push.
 *
 * Never throws, so the push route's sync still reports; a failed pool is counted
 * and logged, and the recompute lane backstops it. Null, logged at error, when the
 * agent's buckets could not be read at all, which is never reported as zero work.
 */
export async function refreshAgentPoolsAfterPush(userId: string): Promise<TouchedPoolsOutcome | null> {
  try {
    const codes = await bucketsForAgent(userId);
    const byKey = new Map<string, string>();
    for (const code of codes) {
      const key = await poolKeyOfCode(code);
      if (!byKey.has(key)) byKey.set(key, code);
    }
    // Sorted, then ROTATED per agent (#3302 reviews): a fixed first two would
    // starve an agent's other pools of push freshness for as long as the isolate
    // lives. Rotating costs nothing to read, where preferring the oldest rows would
    // cost a read per push; the lane still refreshes every pool on its own clock.
    const sorted = [...byKey.keys()].sort();
    const start = sorted.length > 0 ? nextRotation(userId, Date.now()) % sorted.length : 0;
    const keys = [...sorted.slice(start), ...sorted.slice(0, start)];
    const chosen = keys.slice(0, MAX_PUSH_POOLS_PER_CALL);
    // One request per POOL, with one code standing for it: the refresh resolves the
    // whole pool from that code, and a second code of the same pool would only join.
    const settled = await Promise.allSettled(
      chosen.map((key) => poolRefreshes.request(key, byKey.get(key)!, "push", recomputePoolsOf)),
    );
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const outcome: TouchedPoolsOutcome = {
      refreshed: settled.length - failures.length,
      deferred: keys.length - chosen.length,
      failed: failures.length,
      debounced: 0,
    };
    for (const f of failures) {
      log.warn("slot-cache", { msg: "push pool refresh failed", user_id: userId }, f.reason);
    }
    log.info("slot-cache", {
      msg: "agent pools refreshed after push",
      user_id: userId,
      codes: codes.length,
      pools: keys.length,
      ...outcome,
    });
    return outcome;
  } catch (err) {
    log.error("slot-cache", { msg: "push pool refresh could not start", user_id: userId }, err);
    return null;
  }
}

/**
 * The load run's `reads-only` arm (#3258): exactly the reads the coalesced refresh
 * makes for a pool (the representative code's, over the same window), with no
 * compute, no row write and no L1 delete, scheduled by the same coalescing rule so
 * the arm measures the reads of the SAME refreshes the on arm computes.
 */
export async function readPoolInputsAfterBooking(code: string): Promise<void> {
  const key = await poolKeyOfCode(code);
  await bookingReads.request(key, code, "booking", (codes) =>
    forPoolsOf(codes, async (pool, horizon) => {
      const representative = pool[0]!.code;
      const { fromIso, toIso } = slotCacheKey(representative, new Date().toISOString(), horizon);
      await loadBucketSlotInputs(representative, fromIso, toIso);
    }),
  );
}

/**
 * Recompute every bucket an agent affects (their calendar/OOO just changed), one
 * compute per POOL rather than per code (#2922), inside a budget. Resolves to what
 * it did, or null when it could not even work out the agent's buckets. Never
 * throws into a push/cron path: the recompute lane's freshness sweep backstops.
 */
export async function recomputeBucketsForAgent(
  userId: string,
): Promise<TouchedPoolsOutcome | null> {
  try {
    const deadlineMs = Date.now() + AGENT_RECOMPUTE_BUDGET_MS;
    const [codes, buckets, horizon] = await Promise.all([
      bucketsForAgent(userId),
      listPoolBuckets(),
      // Loaded once for the whole fan-out, not once per pool.
      loadBookingHorizonDays(),
    ]);
    const outcome = await recomputeTouchedPools(codes, buckets, {
      nowMs: Date.now,
      deadlineMs,
      recomputePool: (pool) => recomputePoolSlotsForToday(pool, "time-off", undefined, horizon),
      lastRunAt: lastPoolRecomputeAt,
      skipMs: RECOMPUTE_SKIP_MS,
      // The push path is bounded by its budget alone, as it was in #2922: it runs
      // after the response and its deadline is the platform's 30 second cut, which
      // the I/O in every pool compute keeps the clock advancing towards. One agent
      // is in at most a handful of pools, so there is no count to hold it to.
      maxPools: Number.POSITIVE_INFINITY,
    });
    // One line per refresh, so the push path's completed refreshes can be counted
    // against Cloudflare's cancellation warnings (#2922). A cancelled refresh
    // writes nothing, which is why the count lives on the side that finished.
    log.info("slot-cache", { msg: "agent pools recomputed", user_id: userId, codes: codes.length, ...outcome });
    return outcome;
  } catch (err) {
    // Best-effort: the recompute lane's freshness sweep still backstops. Log the
    // cause (#313) so a failed fan-out isn't wholly silent.
    log.error("slot-cache", { msg: "recomputeBucketsForAgent failed", user_id: userId }, err);
    return null;
  }
}

/**
 * The most pools one every minute sweep may refresh inline (#2357): the sync
 * lane's post sync refresh, and each self heal reconcile sweep.
 *
 * Those three used to recompute up to 20 (sync) and 25 (each reconcile) bucket
 * CODES one after another, each a whole pool compute, with no time bound at all.
 * Sixty codes resolve to fifteen pools (#2245), about four codes a pool, so five
 * pools cover roughly the twenty codes the old cap allowed, for a quarter of the
 * computes. On the load test Worker, whose stubbed Google answers instantly and so
 * turns every second of this into CPU, that tail is what took a minute tick to
 * 119,137 ms of CPU against the 120,000 ms kill (run 34991614423).
 *
 * A COUNT rather than only a deadline, because a Worker's clock does not advance
 * during execution: CPU spent computing reads as no time at all, so a deadline
 * alone cannot cap a fan-out whose cost is compute. Pools past it are not lost.
 * The recompute lane refreshes every pool inside its freshness window, which is
 * what has always caught the overflow past the old code cap.
 */
export const MAX_TOUCHED_POOLS_PER_SWEEP = 5;

/**
 * The wall budget beside that count: no pool is STARTED after it. A pool takes
 * about four seconds, so five fit, and this catches the tick where they are slower
 * than that (a database under load) without the count having to be the only bound.
 */
export const TOUCHED_POOLS_BUDGET_MS = 20_000;

/**
 * Refresh the pools a set of bucket codes falls in, for a cron sweep (#2357): one
 * compute per POOL, at most `maxPools` started, none started past the budget.
 *
 * Resolves to what it did, or null when the pool list or the horizon could not be
 * read, which is "could not tell" and never "nothing to do" (#1134). Never throws:
 * every caller is a best effort refresh that the recompute lane backstops. Nothing
 * touched is the ordinary tick and costs no read.
 */
export async function recomputePoolsForCodes(
  codes: string[],
  opts: { label: string; maxPools: number },
): Promise<TouchedPoolsOutcome | null> {
  if (codes.length === 0) return { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  try {
    const deadlineMs = Date.now() + TOUCHED_POOLS_BUDGET_MS;
    const [buckets, horizon] = await Promise.all([listPoolBuckets(), loadBookingHorizonDays()]);
    const outcome = await recomputeTouchedPools(codes, buckets, {
      nowMs: Date.now,
      deadlineMs,
      recomputePool: (pool) => recomputePoolSlotsForToday(pool, `sweep:${opts.label}`, undefined, horizon),
      lastRunAt: lastPoolRecomputeAt,
      skipMs: RECOMPUTE_SKIP_MS,
      maxPools: opts.maxPools,
    });
    // One line per sweep refresh, so the next load run can say how many pools each
    // tick computed and how many it left to the lane, rather than inferring it.
    log.info("slot-cache", {
      msg: "touched pools recomputed",
      label: opts.label,
      codes: codes.length,
      ...outcome,
    });
    return outcome;
  } catch (err) {
    log.error("slot-cache", { msg: "touched pools recompute failed", label: opts.label }, err);
    return null;
  }
}

/**
 * The whole refresh an every minute sweep makes for the agents it changed (#2357):
 * their bucket codes in one batched read (#762), then one bounded, pooled refresh.
 * The sync lane and both self heal reconcile sweeps call this and nothing else, so
 * the shape that let each of them loop a whole pool compute per code cannot come
 * back at one of the three while the other two stay fixed (L613).
 *
 * Every code is passed through, never a code cap applied BEFORE pooling: capping
 * codes first would leave which pools get refreshed to the order of a set. Never
 * throws; a bucket lookup that fails logs and refreshes nothing, and the recompute
 * lane is the backstop for all of it.
 */
export async function refreshPoolsForAgents(
  userIds: string[],
  label: string,
): Promise<TouchedPoolsOutcome | null> {
  if (userIds.length === 0) return { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  const codes = await touchedBucketCodes(userIds, Number.POSITIVE_INFINITY, label);
  return recomputePoolsForCodes(codes, { label, maxPools: MAX_TOUCHED_POOLS_PER_SWEEP });
}

export interface AvailabilityRoutingMeta {
  requested_code: string;
  effective_code: string;
  tier_fallback: boolean;
  rungs_dropped: number;
  requested_tier: string | null;
  booked_tier: string | null;
  /**
   * #2841: every tier the lead's cascade may use was full for the whole offered
   * window, so times past it were served as the last resort. Somebody should look
   * whenever this is true; the availability route alerts on it.
   */
  window_extended: boolean;
  /**
   * #3922: how many open days the window counted, the stored setting as this
   * request read it, so the alert on `window_extended` names the number the lead
   * was actually given rather than a constant. Null when no window was measured.
   */
  offered_open_days: number | null;
}

/**
 * Cached slots for `code`; if the whole horizon window is empty, cascade down
 * the tier ladder (lower debt-tier, same backend+legal digits) and return the
 * first tier that has slots, with a routing descriptor.
 *
 * Returns null only when the requested bucket itself does not exist (→ 404),
 * or when it is a hidden test bucket and the caller isn't authorized for it.
 * When no tier has slots, returns the requested bucket with empty slots and
 * tier_fallback=false so the booker can show the "no availability" state.
 *
 * `authorizedForTest` gates synthetic test buckets (#396): an unauthorized
 * caller gets null here, BEFORE the tier cascade runs, so a hidden test bucket
 * does the same single resolve an unknown code does and its 404 timing doesn't
 * reveal that it exists (#601).
 *
 * `timing` (#3713) records where the read waited: the requested bucket's edge cache,
 * stored row, live compute and business hours each under their own Server-Timing
 * name, and every lower tier the walk reads under ONE `fallback` span, whole. Its
 * parts are not split, so no wait is counted under two names. The business hours
 * read runs beside the cache and row reads (#3713), so the `hours` span overlaps
 * theirs: the parts are waits, not a partition of `slots`.
 *
 * `lookFromMs` (#4014) is for a caller asking for times from a LATER day than now,
 * which today is only Marcia's find_times with a `from` date. When given, nothing
 * before it is served, and both the tier pick and the offered open days are judged
 * from it (from now when it is already past), so "next Friday" is answered with the
 * tier that is open on Friday and the N open days from Friday. The cache, the stored
 * rows and their key are untouched: every read still returns the whole stored
 * horizon from now (#3381), and only this choice moves. The booker and every other
 * caller pass none and are judged from now exactly as before.
 */
export async function getBucketSlotsWithFallback(
  code: string,
  from: string,
  authorizedForTest = false,
  // Injected so the window can be driven at a fixed instant; the route passes its own.
  nowMs = Date.now(),
  timing?: SpanTimer,
  opts: { lookFromMs?: number } = {},
): Promise<(ResolvedBucketSlots & { routing: AvailabilityRoutingMeta }) | null> {
  const timed = spanOrRun(timing);
  const requested = await getCachedBucketSlots(code, from, HORIZON_DAYS, timing);
  if (!requested) return null;
  if (requested.bucket.is_test && !authorizedForTest) return null;

  const withRouting = (
    resolved: ResolvedBucketSlots,
    rungs: number,
    windowExtended = false,
  ): ResolvedBucketSlots & { routing: AvailabilityRoutingMeta } => {
    // #2842: the second list is routing input, never output. The served list was
    // already chosen from it below, so it goes no further than this function.
    const { slotsWithoutLow: _routingOnly, ...slotsFor } = resolved;
    return {
      ...slotsFor,
      routing: {
        requested_code: code,
        effective_code: slotsFor.bucket.code,
        tier_fallback: rungs > 0,
        rungs_dropped: rungs,
        requested_tier: tierKeyOf(code),
        booked_tier: tierKeyOf(slotsFor.bucket.code),
        window_extended: windowExtended,
        offered_open_days: offeredWin?.offeredOpenDays ?? null,
      },
    };
  };

  // #2840: the lead is offered the next N days the business is open, N the stored
  // offered open days (#3922). Null when that cannot be measured, and then no
  // window is imposed: the stored rows already hold the horizon the settings ask
  // for, which is exactly what was served before this existed, so an unreadable
  // week or setting degrades to the old behaviour rather than to no times at all.
  // #4014: the window is counted from the day a caller asked to look from, never
  // from a day already past.
  const floorMs = opts.lookFromMs ?? null;
  const anchorMs = floorMs !== null && floorMs > nowMs ? floorMs : nowMs;
  const offeredWin = await timed(SERVER_TIMING_NAMES.hours, () =>
    offeredWindow(anchorMs, requested.eventType.min_notice_min),
  );
  const windowEndMs = offeredWin?.endMs ?? null;
  // An unreadable stamp is never served to a caller with a floor, as it is never
  // inside a window.
  const fromFloor = (slots: string[]) =>
    floorMs === null ? slots : slots.filter((s) => (parseStampMs(s) ?? -Infinity) >= floorMs);
  const inWindow = (slots: string[]) =>
    windowEndMs === null ? fromFloor(slots) : fromFloor(slots).filter((s) => (parseStampMs(s) ?? Infinity) < windowEndMs);

  // Pre-seed the seen map with the already-fetched requested bucket so neither
  // pass ever fetches it again, and the second pass reads no bucket twice.
  const seen = new Map<string, ResolvedBucketSlots | null>([[code, requested]]);
  const walk = (narrow: (slots: string[]) => string[]) =>
    selectWithTierFallback(code, async (c) => {
      if (!seen.has(c)) seen.set(c, await timed(SERVER_TIMING_NAMES.fallback, () => getCachedBucketSlots(c, from)));
      const row = seen.get(c);
      // Skip synthetic test buckets on the LOWER rungs (the booking cascade skips
      // them too), so a real lower tier wins. The requested bucket is never
      // skipped: a test bucket reaching here was authorised above.
      if (c !== code && row?.bucket.is_test) return null;
      if (!row) return null;
      return narrow(servedSlotsForRung(code, c, row));
    });
  // Serve exactly the list the rung was judged on, so a rung that excludes Low
  // never shows the lead a time only a Low carrier is free for, and a rung found
  // inside the window never shows a time past it.
  const served = (
    winner: { effectiveCode: string; slots: string[]; rungsDropped: number },
    windowExtended: boolean,
  ) => {
    const bucket = seen.get(winner.effectiveCode);
    return bucket ? withRouting({ ...bucket, slots: winner.slots }, winner.rungsDropped, windowExtended) : null;
  };

  // Pass one: the allowed ladder, inside the window. The requested tier is its
  // first rung, so a lead whose own tier has a time inside the window is served it.
  const inside = await walk(inWindow);
  if (inside) return served(inside, false) ?? withRouting({ ...requested, slots: [] }, 0);
  if (windowEndMs === null) return withRouting({ ...requested, slots: [] }, 0);

  // Pass two, the last resort (#2841): every allowed tier is full for the whole
  // window, so the stored times past it are offered, the lead's own tier first.
  // Sam: "All else fails, day 4 which is 100% open." The rows reach the horizon's
  // number of days WITH times, so this is day four in the ordinary case and the
  // next day anybody allowed has free when day four is full too, rather than no
  // times at all. `window_extended` is what the route alerts on: somebody should
  // look whenever this happens.
  const beyond = await walk(fromFloor);
  if (beyond) return served(beyond, true) ?? withRouting({ ...requested, slots: [] }, 0);
  return withRouting({ ...requested, slots: [] }, 0);
}

/**
 * The offered window (#2840): when it closes, the end of the Nth open day with N
 * the stored offered open days (#3922), counting today only while a booking can
 * still start before it closes, and the N it counted.
 *
 * Null when the org's week or the setting cannot be read, or the week holds no
 * such day. Both reads are the cached ones, so this costs no round trip on most
 * requests, and both keep their last known value through a failed refresh; null
 * is reached only on a cold isolate whose first read failed, where the stored
 * rows are served as they are rather than cut by a number nobody saved.
 */
async function offeredWindow(
  nowMs: number,
  minNoticeMin: number,
): Promise<{ endMs: number; offeredOpenDays: number } | null> {
  try {
    const [hours, offeredOpenDays] = await Promise.all([loadBusinessHoursCached(), loadOfferedOpenDaysCached()]);
    const endMs = offeredWindowEndFor(hours, nowMs, minNoticeMin, offeredOpenDays);
    return endMs === null ? null : { endMs, offeredOpenDays };
  } catch (err) {
    log.warn("availability", { msg: "offered window unmeasured, serving the stored horizon" }, err);
    return null;
  }
}

/**
 * Best-effort clear of a bucket's L1 cache key (per-datacenter, no prefix-list).
 * Retained for callers that only need to drop the cache; prefer
 * recomputeBucketSlotsForToday when the underlying availability changed.
 *
 * One key per bucket (#3366): it used to delete only the key for today's UTC day,
 * while an evening US lead's entry sat under yesterday's. Still this colo only:
 * every other colo's entry ages out on `SLOT_TTL_SECONDS`.
 */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const cache = slotCache();
  if (!cache) return;
  try {
    await cache.delete(keyRequest(slotCacheEntryKey(code, HORIZON_DAYS)));
  } catch { /* ignore */ }
}
