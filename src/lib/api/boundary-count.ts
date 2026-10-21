import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import {
  BOUNDARY_CATCH_COUNTER,
  BOUNDARY_COUNT_WINDOW_SECONDS,
  OPAQUE_SCRIPT_ERROR_ADDRESS_COUNTER,
  OPAQUE_SCRIPT_ERROR_BURST_COUNTER,
  OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS,
  UNRECOGNISED_PAGE_COUNTER,
} from "@/lib/rate-limit-core";

/**
 * How often a page's error boundary has caught, in a rolling window (#1974).
 *
 * ## Why a count and not a send
 *
 * The boundary alert shipped paging on the FIRST catch. That is the shape L77
 * warns about from the other side: one stray fault and a page broken for
 * everybody arrive on the same path and read identically, and here the stray one
 * is the common case. A stale bundle after a deploy, a chunk that failed to
 * load, one person's extension: each produces exactly one catch, on one load, by
 * one person, and each would page.
 *
 * The issue's own verify line is "one person hitting one broken screen does not
 * page", and a count is the only thing that can tell that apart from a page
 * nobody can use.
 *
 * ## Why it borrows the rate limiter's counter
 *
 * `rate_limit_hit` is already an atomic count-under-a-key-in-a-rolling-window,
 * committed in one statement, correct under concurrent callers, and pruned by
 * its own window (the window counter group of `rateLimitPrunePlan`, #3176). That is exactly this question, so it is asked rather than
 * reimplemented beside it (L370: a second implementation of one rule drifts, and
 * this one would drift silently because nothing compares them).
 *
 * `p_max = 1` makes the RPC's own boolean the floor decision, taken atomically
 * inside the increment: `true` is the first catch in the window, `false` is the
 * second or later. The count read afterwards is for the MESSAGE only, so a race
 * with a concurrent catch can only make the reported number arrive one behind,
 * never change whether anybody is paged.
 *
 * ## Which way it fails
 *
 * OPEN, meaning it pages. This is the alerting path, and a counter hiccup that
 * silently withheld a page would mute the one detector that exists for a page
 * nobody can use. A run that could not count says so instead of naming a number
 * it does not have (L11).
 */

/** The window a page's catches are counted over. Equal to the alert's own
 *  cooldown on purpose: a break that persists across the window pages again,
 *  which is the same cadence the cooldown already allows. */
export const BOUNDARY_WINDOW_MS = BOUNDARY_COUNT_WINDOW_SECONDS * 1000;

/** The key space, distinct from every rate limiting rule prefix, and keyed on the
 *  same signature the alert is keyed on so the count and the page cannot end up
 *  describing different things (L70). */
const COUNT_PREFIX = BOUNDARY_CATCH_COUNTER.prefix;

export interface BoundaryCount {
  /** Whether this catch is the SECOND or later in the window, which is what
   *  decides whether anybody is paged. */
  repeated: boolean;
  /** How many catches this page has had in the window, or `null` when that could
   *  not be read. Never a default: 0 or 1 would both be sentences the message
   *  had not measured. */
  count: number | null;
  /** False when the counter itself could not answer, which is what turns
   *  `repeated` into a fail-open assumption rather than a measurement. */
  measured: boolean;
}

/**
 * Record one catch and say whether it is a repeat.
 *
 * Never throws: everything below is best effort, and a monitoring failure must
 * not become a failure of the endpoint it monitors.
 */
export async function countBoundaryCatch(signature: string): Promise<BoundaryCount> {
  return countInWindow(COUNT_PREFIX, signature);
}

/** The key space for reports from pages Slate does not serve (#2755), distinct
 *  from the boundary one so a boundary catch on an invented path is not counted
 *  twice under one key. */
const UNRECOGNISED_PAGE_PREFIX = UNRECOGNISED_PAGE_COUNTER.prefix;

/**
 * Record one report from a page Slate does not serve, and say how many there have
 * been in the window (#2755).
 *
 * Every such page reports under ONE key, `other`, because the path is text any
 * caller can post and a key per invented path was unbounded. One key makes a storm
 * of them one line; this count is what makes that one line say how big the storm
 * is, rather than reading like a single stray report. Nothing is decided on it, so
 * it returns the figure alone, `null` with `measured: false` when the counter could
 * not answer, and never throws.
 */
export async function countUnrecognisedPageReport(
  signature: string,
): Promise<{ count: number | null; measured: boolean }> {
  const seen = await countInWindow(UNRECOGNISED_PAGE_PREFIX, signature);
  return { count: seen.count, measured: seen.measured };
}

/** One atomic count under `prefix:signature` over `BOUNDARY_WINDOW_MS`. */
async function countInWindow(prefix: string, signature: string): Promise<BoundaryCount> {
  const key = `${prefix}:${signature}`;
  const hit = await hitCounter(key, Math.round(BOUNDARY_WINDOW_MS / 1000), 1, "boundary count");
  if (!hit.ok) return { repeated: true, count: null, measured: false };
  // `within` is the FIRST catch in the window: inside the ceiling of one, so not
  // yet a repeat, and no read back is needed for a figure nobody is told.
  if (hit.within) return { repeated: false, count: 1, measured: true };
  // The number is for the message alone. An unreadable count still pages, and the
  // copy then omits the figure rather than inventing one.
  return { repeated: true, count: await readCount(key), measured: true };
}

/** What one `rate_limit_hit` answered: whether the count is still inside `max`, or
 *  that it could not answer at all. */
type CounterHit = { ok: true; within: boolean } | { ok: false };

/**
 * One atomic increment of `key` in its fixed window, and whether the count is now
 * at most `max`. The one place a window counter calls the RPC, so the boundary,
 * unrecognised page and opaque script error counts cannot drift into three readings
 * of it (L370). Never throws; a failure is logged under `tag=client-errors` and
 * returned as `ok: false`, and each caller decides which way that falls.
 */
async function hitCounter(key: string, windowSeconds: number, max: number, what: string): Promise<CounterHit> {
  try {
    const { data, error } = await supabaseAdmin().rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max: max,
    });
    if (error) {
      log.error("client-errors", { msg: `${what} failed`, key }, error);
      return { ok: false };
    }
    return { ok: true, within: data === true };
  } catch (err) {
    log.error("client-errors", { msg: `${what} threw`, key }, err);
    return { ok: false };
  }
}

/** The count a window counter holds now, or null when it cannot be read or is not
 *  a number. Never a default: 0 or 1 would be figures nobody measured. Never throws. */
async function readCount(key: string): Promise<number | null> {
  try {
    // error-ok: a figure for a message or a log line alone; null says it is unread.
    const { data: row } = await supabaseAdmin()
      .from("rate_limits")
      .select("count")
      .eq("key", key)
      .maybeSingle();
    const count = (row as { count?: unknown } | null)?.count;
    return typeof count === "number" ? count : null;
  } catch {
    // swallow-ok: the caller already holds the decision this figure only decorates,
    // and null is the honest "unread" the copy is written for.
    return null;
  }
}

/**
 * How many DISTINCT addresses on one surface must send an opaque cross origin
 * script error inside `OPAQUE_BURST_WINDOW_MS` before anybody is paged (#3323).
 *
 * ## How it was sized
 *
 * One lead's browser cannot trip it, by construction rather than by margin: the
 * count is of ADDRESSES, each counted once per window however often it reports. The
 * beacon already sends a given message at most once per page load
 * (`ClientErrorBeacon`), so a lead reloading or retrying sends one report per load,
 * and every one of those after the first lands on the same address row and adds
 * nothing. Counting reports instead could not have been made safe: the beacon's own
 * limiter lets one address send 10 a minute and 60 an hour, so any report threshold
 * one reloading browser could not reach would be too high to ever hear a real burst.
 *
 * The background is rare. These reports paged on 2026-10-05 and 2026-10-21, two in
 * sixteen days, and the hour around the second held exactly that one report in the
 * Worker logs. Five unrelated browsers, each with its own extension or translator,
 * inside one fifteen minute window is not something that rate produces.
 *
 * What five in fifteen minutes does catch is the case worth waking for: something
 * from another origin failing on every load of the page for some whole population of
 * browsers (an in app browser's injected script, a widely installed extension), at
 * one affected load every three minutes or more. Anything rarer is still logged and
 * counted under `tag=client-errors`, so it can be found, just never paged.
 *
 * Several leads behind one shared address (a carrier's NAT) count once, which
 * undercounts: the safe direction for a page that must not cry wolf (L36).
 */
export const OPAQUE_BURST_THRESHOLD = 5;

/** The window the burst is counted over, and the page's own cooldown, so a burst
 *  that goes on pages once per window. */
export const OPAQUE_BURST_WINDOW_MS = OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS * 1000;

export interface OpaqueBurstCount {
  /** Whether this report's address had not already reported on this surface in the
   *  window, so it was added to the count. */
  newAddress: boolean;
  /** Distinct addresses this window, or null when that could not be read. */
  addresses: number | null;
  /** Whether the count has reached `OPAQUE_BURST_THRESHOLD`: what decides the page. */
  burst: boolean;
  /** False when the counter itself could not answer. */
  measured: boolean;
}

/**
 * Record one opaque cross origin script error from `address` on the surface
 * `signature`, and say whether distinct addresses have reached the burst (#3323).
 *
 * Two atomic hits on the same counter as everything above: the address row (ceiling
 * one, so its boolean says whether this address is new in the window), and only for
 * a new address, the surface's count with a ceiling one under the threshold, so the
 * RPC's own boolean, taken inside the increment, is the burst decision. Two reports
 * racing cannot both miss it. The figure read back afterwards is for the log and the
 * copy alone.
 *
 * The two rows keep separate fixed windows, so an address can stay counted a little
 * past the burst window's reset and go uncounted in the next one. That undercounts,
 * which is the safe direction here.
 *
 * ## Which way it fails
 *
 * CLOSED, meaning nobody is paged, the opposite of the boundary count and on purpose.
 * The limiter in front of this route asks the same RPC and drops every report when it
 * cannot answer, so a counter outage is mostly an outage that already silenced the
 * beacon; and failing open would page on every single opaque report while it lasted,
 * which is exactly the noise this count exists to end. The failure is logged at error.
 * Never throws.
 */
export async function countOpaqueScriptError(signature: string, address: string): Promise<OpaqueBurstCount> {
  const unmeasured: OpaqueBurstCount = { newAddress: false, addresses: null, burst: false, measured: false };
  const windowSeconds = OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS;
  const countKey = `${OPAQUE_SCRIPT_ERROR_BURST_COUNTER.prefix}:${signature}`;

  const seen = await hitCounter(
    `${OPAQUE_SCRIPT_ERROR_ADDRESS_COUNTER.prefix}:${signature}:${address}`,
    windowSeconds,
    1,
    "opaque script error address count",
  );
  if (!seen.ok) return unmeasured;
  if (!seen.within) {
    // A browser that already reported this window: not counted again, and never the
    // report that makes a burst, since the burst fell on a NEW address if it fell.
    return { newAddress: false, addresses: await readCount(countKey), burst: false, measured: true };
  }

  const counted = await hitCounter(countKey, windowSeconds, OPAQUE_BURST_THRESHOLD - 1, "opaque script error count");
  if (!counted.ok) return unmeasured;
  return {
    newAddress: true,
    addresses: await readCount(countKey),
    burst: !counted.within,
    measured: true,
  };
}

