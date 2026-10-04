// How the preflight chooses and books its control slot (#3236).
//
// WHY. Load run 37225186978 (2026-10-04) declared itself warm about three seconds
// after hydration drive 7. That drive gave the only New York agent still free at
// the first offered time a stub meeting over it, and the preflight then booked that
// time from a slot list computed BEFORE the drive. The confirm path correctly found
// nobody free and answered 409 SLOT_TAKEN, so the run was lost to the preflight's
// own stale list. Whether it bit depended on the time of day the run was dispatched,
// because the stub meeting grid is anchored to each calendar's hydration time
// (src/lib/google/loadtest-stub.ts).
//
// A recompute drive cannot be trusted as a refresh on its own: the lane recomputes
// only the pools it judges due (`poolsDueForRecompute`, RECOMPUTE_FRESH_MS), it
// answers `skipped: overlapping-run` when the scheduled tick holds its lock, and a
// hydration drive does not refresh any pool itself. So the preflight waits for the
// EVIDENCE instead: the control bucket's stored row carrying a `computed_at` later
// than the event that could have made it stale. `computed_at` is the instant the
// compute STARTED (src/lib/availability/slot-row-write.ts), so a row stamped after
// the event was computed over the calendars as they stood after it.
//
// Two places use that wait:
//
//   after a warm up that drove hydration, before the control slot is chosen;
//
//   after a SLOT_TAKEN, before the one retry re-reads the times. A second refusal
//   still fails the preflight, naming both times, because two lost slots in a row is
//   no longer a race with our own drive and says something about the run.
//
// Every wait here takes an injected clock and sleep, so all of it is driven offline
// with nothing waiting for real (L524).
import { offeredSlots } from "./book-plan.ts";
import { SLOT_TTL_SECONDS } from "../../src/lib/availability/slot-cache.ts";
import { RECOMPUTE_FRESH_MS } from "../../src/lib/availability/precompute-cron.ts";
import { parseStampMs } from "../../src/lib/date/stamp.ts";

/**
 * How long to wait before any re-read of the offered times.
 *
 * /api/availability answers first from the edge cache (`caches.default`) for
 * SLOT_TTL_SECONDS, and a recompute deletes that entry only for the pools it
 * actually recomputed, in the colo it ran in. Waiting out the cache lifetime, plus
 * a margin for clock and delivery slack, means the re-read reaches the stored row.
 * Derived from the shipped TTL so raising it raises this rather than leaving the
 * wait short.
 */
const SLOT_CACHE_SETTLE_MARGIN_MS = 1_500;
export const SLOT_CACHE_SETTLE_MS = SLOT_TTL_SECONDS * 1000 + SLOT_CACHE_SETTLE_MARGIN_MS;

/** The scheduled recompute lane's cadence: every minute. */
const RECOMPUTE_CRON_CADENCE_MS = 60_000;
const ROW_FRESHNESS_MARGIN_MS = 60_000;

/**
 * How long to wait for the stored row to postdate an event before giving up.
 *
 * A pool comes due at the latest RECOMPUTE_FRESH_MS after its last compute (the
 * jitter only pulls that earlier), and the scheduled lane runs every minute, so a
 * wait shorter than both could give up on a pool that was about to refresh. The
 * margin covers a tick that ran out of budget before reaching this pool.
 */
export const ROW_FRESHNESS_DEADLINE_MS =
  RECOMPUTE_FRESH_MS + RECOMPUTE_CRON_CADENCE_MS + ROW_FRESHNESS_MARGIN_MS;

/** How often the wait drives recompute and reads the row again. */
export const ROW_FRESHNESS_POLL_MS = 15_000;

/**
 * `computed_at` is the Worker's clock and the event time is the runner's, so a
 * compute that started just BEFORE the event could carry a stamp just after it on a
 * runner whose clock lags. Requiring this much clear water costs at most one more
 * poll and keeps that compute from passing as evidence.
 */
const CLOCK_SKEW_ALLOWANCE_MS = 2_000;

export type Sleep = (ms: number) => Promise<void>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What the wait for a fresh stored row needs from the outside world. */
export interface FreshRowDeps {
  /** Drives /api/cron/recompute once. */
  driveRecompute: () => Promise<string>;
  /** The control bucket's stored `bucket_slots.computed_at`, or null with no row. */
  readComputedAt: () => Promise<string | null>;
  sleep: Sleep;
  now: () => number;
  bucketCode: string;
  log?: (line: string) => void;
}

export type FreshRowOutcome = { ok: true; computedAt: string } | { ok: false; why: string };

/**
 * Poll until the control bucket's stored row was computed after `afterMs`, driving
 * recompute on every poll so a due pool is refreshed now rather than on the next
 * scheduled tick. Bounded by ROW_FRESHNESS_DEADLINE_MS, after which it fails naming
 * the bucket, the row's stamp and the event it was waiting on.
 *
 * A missing row or an unreadable stamp is never fresh (L50).
 */
export async function waitForFreshSlotRow(
  afterMs: number,
  since: string,
  deps: FreshRowDeps,
): Promise<FreshRowOutcome> {
  const startMs = deps.now();
  let polls = 0;
  for (;;) {
    await deps.driveRecompute();
    const stamp = await deps.readComputedAt();
    polls++;
    const at = parseStampMs(stamp);
    if (at !== null && at > afterMs + CLOCK_SKEW_ALLOWANCE_MS) {
      deps.log?.(
        `bucket ${deps.bucketCode}'s stored slots were computed at ${stamp}, after ${since} ` +
          `(${new Date(afterMs).toISOString()}), on poll ${polls}`,
      );
      return { ok: true, computedAt: String(stamp) };
    }
    if (deps.now() - startMs >= ROW_FRESHNESS_DEADLINE_MS) {
      const rowSays =
        stamp === null
          ? "there is no stored row for it at all"
          : at === null
            ? `its stored row carries an unreadable computed_at (${JSON.stringify(stamp)})`
            : `its stored row was last computed at ${stamp}`;
      return {
        ok: false,
        why:
          `bucket ${deps.bucketCode}'s stored slots never postdated ${since} ` +
          `(${new Date(afterMs).toISOString()}) within ${Math.round(ROW_FRESHNESS_DEADLINE_MS / 1000)}s ` +
          `of driving recompute every ${ROW_FRESHNESS_POLL_MS / 1000}s: ${rowSays}. Its offered times ` +
          "cannot be shown to reflect the calendars as they now stand, so no control booking was made.",
      };
    }
    await deps.sleep(ROW_FRESHNESS_POLL_MS);
  }
}

/**
 * Whether the warm up's slot list may predate the calendars it judged.
 *
 * Any hydration drive can write stub meetings that the slot cache has not been
 * recomputed over yet, so a list read in the same pass is not to be trusted for a
 * real booking. With no drive the list was computed over calendars nothing touched.
 */
export function needsPostWarmupRefresh(p: { hydrationDrives: number }): boolean {
  return p.hydrationDrives > 0;
}

/** The times a bucket offers, through the shared reader; throws on a refusal. */
export async function readOfferedSlots(fetchImpl: FetchLike, baseUrl: string, code: string): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/api/availability?bucket=${encodeURIComponent(code)}`);
  if (!res.ok) {
    throw new Error(`availability for bucket ${code} answered ${res.status}, so no control booking could be made`);
  }
  return offeredSlots(await res.json());
}

export type RefreshOutcome = { ok: true; refreshed: boolean; slots: string[] } | { ok: false; why: string };

/**
 * When the warm up drove hydration, wait for the stored row to postdate the last
 * drive, wait out the edge cache, and read the offered times again. Otherwise the
 * warm up's own list stands and nothing is spent.
 */
export async function refreshAfterWarmup(
  p: { hydrationDrives: number; lastHydrationFinishedMs: number | null },
  slots: string[],
  deps: FreshRowDeps & { readSlots: () => Promise<string[]> },
): Promise<RefreshOutcome> {
  if (!needsPostWarmupRefresh(p)) return { ok: true, refreshed: false, slots };
  if (p.lastHydrationFinishedMs === null) {
    return {
      ok: false,
      why:
        `${p.hydrationDrives} hydration drive(s) ran and none recorded when it finished, so there is ` +
        "no time the stored slots can be shown to postdate",
    };
  }
  const row = await waitForFreshSlotRow(p.lastHydrationFinishedMs, "the last hydration drive", deps);
  if (!row.ok) return row;
  await deps.sleep(SLOT_CACHE_SETTLE_MS);
  const fresh = await deps.readSlots();
  deps.log?.(`re-read bucket ${deps.bucketCode} after the refresh: ${fresh.length} times offered now`);
  return { ok: true, refreshed: true, slots: fresh };
}

export interface ControlBookingDeps extends FreshRowDeps {
  fetch: FetchLike;
  baseUrl: string;
  apiKey: string;
  /** The booking body for a given start; the caller owns the attendee and ids. */
  bodyFor: (start: string) => Record<string, unknown>;
}

export type ControlBookingOutcome =
  | { ok: true; start: string; attempts: number; status: number; body: string }
  | { ok: false; why: string };

function refusalCode(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Book the control on the first offered time. On a lost slot, wait for the stored
 * row to postdate the refusal, wait out the edge cache, read again, and try the
 * next offered time once. Never a third attempt.
 */
export async function bookControlSlot(
  slots: string[],
  deps: ControlBookingDeps,
): Promise<ControlBookingOutcome> {
  const first = slots[0];
  if (first === undefined) {
    return { ok: false, why: `bucket ${deps.bucketCode} offered no times, so no control booking could be made` };
  }

  const attempt = async (start: string, n: number) => {
    deps.log?.(`control booking attempt ${n}: bucket ${deps.bucketCode} at ${start}`);
    const res = await deps.fetch(`${deps.baseUrl}/api/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(deps.bodyFor(start)),
    });
    return { status: res.status, text: await res.text() };
  };

  const one = await attempt(first, 1);
  if (one.status === 200) return { ok: true, start: first, attempts: 1, status: one.status, body: one.text };
  if (one.status !== 409 || refusalCode(one.text) !== "SLOT_TAKEN") {
    return { ok: false, why: `the control booking was answered ${one.status}: ${one.text.slice(0, 300)}` };
  }
  const refusedAtMs = deps.now();

  // Read again rather than take the next entry of the stale list: the list that
  // offered a taken time is the thing in doubt. Only once the stored row postdates
  // the refusal, and only after the edge cache has had time to let it through.
  const row = await waitForFreshSlotRow(refusedAtMs, `the SLOT_TAKEN refusal at ${first}`, deps);
  if (!row.ok) {
    return {
      ok: false,
      why: `the control booking at ${first} was answered 409 SLOT_TAKEN, and the retry could not proceed: ${row.why}`,
    };
  }
  await deps.sleep(SLOT_CACHE_SETTLE_MS);
  const fresh = await readOfferedSlots(deps.fetch, deps.baseUrl, deps.bucketCode);
  const next = fresh.find((s) => s !== first);
  if (next === undefined) {
    return {
      ok: false,
      why:
        `the control booking at ${first} was answered 409 SLOT_TAKEN, and a fresh read of bucket ` +
        `${deps.bucketCode} offered no other time to retry on`,
    };
  }
  deps.log?.(`control booking at ${first} met SLOT_TAKEN; retrying once at the next offered time`);

  const two = await attempt(next, 2);
  if (two.status === 200) return { ok: true, start: next, attempts: 2, status: two.status, body: two.text };
  const secondCode = refusalCode(two.text);
  return {
    ok: false,
    why:
      `the control booking was refused twice in bucket ${deps.bucketCode}: ${first} answered 409 ` +
      `SLOT_TAKEN, then ${next} answered ${two.status}` +
      (secondCode ? ` ${secondCode}` : "") +
      `: ${two.text.slice(0, 300)}`,
  };
}
