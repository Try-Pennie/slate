/**
 * Finding the first bookable days on the far side of a closure (#1329, #1339).
 *
 * The ordinary availability search is bounded for cost: recompute is roughly
 * super-linear in the window and every bucket pays it on every pass, which is why
 * `MAX_CLOSED_RUN_DAYS` buys a closed weekend and no more (#1326). So during a
 * genuinely long closure the honest answer is "nothing", and a lead is left with
 * no idea when to come back.
 *
 * This is the way through, and it is deliberately NOT part of the cached path: it
 * runs only for a lead who asks, so the cost is paid by the few who arrive during
 * a shutdown rather than by every bucket on every recompute pass.
 *
 * ## Why it walks in chunks rather than computing one long window
 *
 * A single 60 day compute for one bucket is the kind of request that meets the
 * Worker CPU ceiling, and it would pay for the whole lookahead even when the answer
 * sits three days in. Walking forward in short windows stops at the first chunk
 * that yields enough days, so a two week shutdown costs a few cheap computes and
 * the common case costs one. The cap is what keeps an indefinitely dark roster
 * (today's state, #1272) from turning one lead's click into an unbounded bill.
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives the walk directly.
 */
import { DateTime } from "luxon";

/** Days per probe. A week at a time: long enough to clear a weekend plus a
 *  holiday in one go, short enough that a single compute stays cheap. */
export const PROBE_WINDOW_DAYS = 7;

/**
 * How far ahead we are willing to look at all.
 *
 * Eight weeks. A Christmas shutdown is under two, so this clears every real
 * closure with room to spare, and beyond it the honest answer is that we cannot
 * say rather than a bigger bill on a request a lead is waiting on. It also bounds
 * the walk when NOTHING is bookable for reasons other than a closure, which is the
 * live state while the routing pool is off.
 */
export const MAX_LOOKAHEAD_DAYS = 56;

/** One window to compute, as ISO instants. */
export interface Probe {
  fromIso: string;
  toIso: string;
}

/**
 * The windows to try, in order, starting the day after the ordinary search gave
 * up. Bounded by `MAX_LOOKAHEAD_DAYS`; the caller stops as soon as a probe yields
 * enough bookable days, so the later entries are usually never computed.
 *
 * `searchedThroughDay` is the last day the ordinary search already covered, so the
 * walk never re-computes ground that came back empty.
 */
export function probeWindows(input: {
  searchedThroughDay: string;
  zone: string;
}): Probe[] {
  const start = DateTime.fromISO(input.searchedThroughDay, { zone: input.zone });
  if (!start.isValid) return [];
  const probes: Probe[] = [];
  for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS; offset += PROBE_WINDOW_DAYS) {
    const from = start.plus({ days: offset }).startOf("day");
    const spanEnd = Math.min(offset + PROBE_WINDOW_DAYS - 1, MAX_LOOKAHEAD_DAYS);
    const to = start.plus({ days: spanEnd }).endOf("day");
    const fromIso = from.toUTC().toISO();
    const toIso = to.toUTC().toISO();
    if (fromIso && toIso) probes.push({ fromIso, toIso });
  }
  return probes;
}

/**
 * How many windows the walk computes at once (#2799).
 *
 * Two, and the reason it is not more is where a window's time actually goes.
 * Measured locally against live data for bucket 100 (80 members) on 2026-09-25,
 * one window spent about 330ms reading (bucket, pool, schedules, busy_blocks pages,
 * the daily cap count RPC) and about 870ms in `computeBucketSlots`. A Worker runs
 * a request's JavaScript on ONE thread, so two windows can never compute at the
 * same time; the only saving concurrency can buy is one window's reads hiding
 * behind another window's compute. At roughly 30% reads and 70% compute, a second
 * window in flight hides most of it, and a third adds connections and wasted work
 * past the answer for little more. The same day, full 8 window walks of bucket 100
 * run locally (three each, medians): one at a time 10.8s, two 8.3s, three 7.8s,
 * four 7.8s, against a compute only floor of about 6.8s.
 *
 * The platform arithmetic (docs/cloudflare-platform-notes.md, and Cloudflare's six
 * simultaneous open connections per invocation):
 *
 *  - Connections. One window holds at most 4 fetches open at once, briefly, as it
 *    starts (org name, business hours, and the two pool reads, `bucket_members`
 *    and `users`), and 2 for the rest of its life (a busy_blocks page beside the
 *    count RPC). Two windows therefore hold 4 in their long phase, inside 6. The
 *    only moment they can reach 8 is when both are opening together, at the very
 *    start of the walk; Cloudflare QUEUES a connection past the sixth rather than
 *    failing it, so the cost of that moment is one short read waiting behind
 *    another, never an error. A cap of 3 would sit at 6 in the long phase with no
 *    headroom for anything else the request opens.
 *  - Subrequests. Concurrency does not add reads, it reorders them: a full walk is
 *    the same 8 windows of roughly 10 reads each, about 80, against a ceiling of
 *    10,000 per invocation. What it CAN add is work past the answer, and that is
 *    bounded by the cap: at most one window (about 10 reads) that a serial walk
 *    would not have started.
 *  - CPU. Unchanged, since the same windows are computed; the full Low walk is
 *    roughly 8 x 1s of compute against the Worker's raised `limits.cpu_ms`.
 */
export const NEXT_WINDOW_CONCURRENCY = 2;

/**
 * What one window costs at the deepest pool, measured against production on
 * 2026-09-25 (#1365): a Low bucket, 79 staffed agents, about 2.5s per 7 day window
 * (0.5s fixed plus about 30ms per eligible agent). The booker's wait is derived
 * from this, so a re-measurement is a change to one number here.
 */
export const NEXT_WINDOW_COST_MS = 2_500;

/**
 * The slowest walk the server can make: every window, and no overlap at all.
 *
 * Deliberately pessimistic. Concurrency hides a window's reads behind another's
 * compute, but compute dominates and cannot overlap on one thread, so the honest
 * bound for a client to wait on is the serial one rather than the optimistic one.
 */
export const NEXT_WALK_WORST_CASE_MS =
  Math.ceil(MAX_LOOKAHEAD_DAYS / PROBE_WINDOW_DAYS) * NEXT_WINDOW_COST_MS;

/**
 * How long the booker waits for this one request before calling it failed (#2799).
 *
 * The shared `REQUEST_TIMEOUT_MS` (20s) is sized for a booking POST, and the full
 * Low walk used to land right on it, so the lead arriving during the longest
 * closure, the one the button exists for, was the one most likely to see a
 * timeout. Half again over the serial worst case: the production measurement ran
 * up to about 1.3 times its typical figure on a cold start, and the pool grows. The
 * still-alive cue (#1364) covers the wait from ten seconds on, and past this the
 * request still becomes the ordinary "could not look" failure with its retry.
 */
export const NEXT_DAYS_TIMEOUT_MS = Math.ceil(NEXT_WALK_WORST_CASE_MS * 1.5);

/**
 * Walk the probes until `wantDays` distinct bookable days have been found, and
 * return every slot on those days.
 *
 * Returns what it HAS when the lookahead runs out, including nothing. Fewer days
 * than asked for is the honest answer during an open ended closure, and inventing
 * or padding would be a promise about times nobody can book.
 *
 * Windows are computed up to `concurrency` at a time (#2799), and the answer is
 * exactly the one a one at a time walk would give: results are folded strictly in
 * window order, so a later window that finishes first waits for the earlier ones
 * and never jumps ahead of them. Once the folded prefix holds enough days no new
 * window is started, and anything still in flight is ignored.
 *
 * A window that fails REJECTS the walk, as it did when the walk was serial, as long
 * as it sits before the answer. It is never folded in as "no slots": an empty
 * answer here tells a lead we have no times, and "could not look" is a different
 * screen. A failure in a window past the answer is ignored, since a serial walk
 * would never have run it.
 *
 * `compute` is injected so the walk is tested without any IO, and so the caller
 * owns the uncached compute (this must never write the slot cache: the days it
 * finds lie outside the horizon every other reader is keyed on).
 */
export async function findNextAvailableSlots(input: {
  probes: Probe[];
  wantDays: number;
  zone: string;
  compute: (probe: Probe) => Promise<string[]>;
  concurrency?: number;
}): Promise<string[]> {
  if (input.wantDays <= 0) return [];
  const { probes, wantDays } = input;
  const cap = Math.max(1, Math.floor(input.concurrency ?? NEXT_WINDOW_CONCURRENCY));
  const byDay = new Map<string, string[]>();

  const fold = (slots: string[]) => {
    for (const iso of slots) {
      const day = DateTime.fromISO(iso).setZone(input.zone).toISODate();
      if (!day) continue;
      const existing = byDay.get(day);
      if (existing) existing.push(iso);
      else byDay.set(day, [iso]);
    }
  };
  const answer = () => {
    const days = [...byDay.keys()].sort().slice(0, wantDays);
    return days
      .flatMap((day) => byDay.get(day) ?? [])
      .sort((a, b) => Date.parse(a) - Date.parse(b));
  };

  type Outcome = { ok: true; slots: string[] } | { ok: false; error: unknown };
  const outcomes: Array<Outcome | undefined> = new Array(probes.length);

  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let folded = 0; // windows folded in, strictly in order
    let launched = 0;
    let inFlight = 0;
    // The earliest window known to have failed. Nothing past it is worth starting:
    // either the windows before it already answer, or the walk rejects there.
    let firstFailure = probes.length;

    const advance = () => {
      if (settled) return;
      try {
        while (folded < probes.length) {
          const outcome = outcomes[folded];
          if (!outcome) break;
          if (!outcome.ok) {
            settled = true;
            reject(outcome.error);
            return;
          }
          fold(outcome.slots);
          folded++;
          // Stop once the folded prefix has enough days. Checked AFTER a whole
          // window is folded in, so a day split across a boundary is complete.
          if (byDay.size >= wantDays) {
            settled = true;
            resolve(answer());
            return;
          }
        }
        if (folded === probes.length) {
          settled = true;
          resolve(answer());
          return;
        }
        while (inFlight < cap && launched < Math.min(probes.length, firstFailure + 1)) {
          launch(launched++);
        }
      } catch (err) {
        settled = true;
        reject(err);
      }
    };

    const launch = (i: number) => {
      inFlight++;
      let pending: Promise<string[]>;
      try {
        pending = Promise.resolve(input.compute(probes[i]));
      } catch (err) {
        pending = Promise.reject(err);
      }
      // Both branches are handled here, so a window ignored after the answer can
      // settle late, even by failing, without an unhandled rejection.
      pending
        .then(
          (slots) => {
            outcomes[i] = { ok: true, slots };
          },
          (error: unknown) => {
            outcomes[i] = { ok: false, error };
            firstFailure = Math.min(firstFailure, i);
          },
        )
        .finally(() => {
          inFlight--;
          advance();
        });
    };

    advance();
  });
}
