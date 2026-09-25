import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

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
 * its own window. That is exactly this question, so it is asked rather than
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
export const BOUNDARY_WINDOW_MS = 30 * 60_000;

/** The key space, distinct from every rate limiting rule prefix, and keyed on the
 *  same signature the alert is keyed on so the count and the page cannot end up
 *  describing different things (L70). */
const COUNT_PREFIX = "boundary_count";

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
const UNRECOGNISED_PAGE_PREFIX = "unrecognised_page_count";

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
  const db = supabaseAdmin();
  try {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: Math.round(BOUNDARY_WINDOW_MS / 1000),
      p_max: 1,
    });
    if (error) {
      log.error("client-errors", { msg: "boundary count failed", key }, error);
      return { repeated: true, count: null, measured: false };
    }
    // `data === true` is the FIRST catch in the window: within the ceiling of
    // one, so not yet a repeat.
    const repeated = data === false;
    if (!repeated) return { repeated: false, count: 1, measured: true };
    // error-ok: the number is for the message alone. An unreadable count still
    // pages, and the copy then omits the figure rather than inventing one.
    const { data: row } = await db
      .from("rate_limits")
      .select("count")
      .eq("key", key)
      .maybeSingle();
    const count = typeof (row as { count?: unknown } | null)?.count === "number"
      ? ((row as { count: number }).count)
      : null;
    return { repeated: true, count, measured: true };
  } catch (err) {
    log.error("client-errors", { msg: "boundary count threw", key }, err);
    return { repeated: true, count: null, measured: false };
  }
}
