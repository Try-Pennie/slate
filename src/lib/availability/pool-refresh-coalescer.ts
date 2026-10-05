/**
 * Coalesce the slot refresh a booking schedules, per POOL (#3258).
 *
 * Every confirmed booking refreshes the booked bucket's offered times after its
 * response, so the booked time stops being offered (#2345, #2968). That was a whole
 * availability compute per booking, for one CODE. The three arm load run on
 * 2026-10-04 measured it as the code half of the confirm slowdown: with it off the
 * steady pass fell from 5.8s to 4.3s at the median, confirms waited 1.05s rather
 * than 3.0s at the p95 before starting, and per request CPU fell from 2.4s to 0.6s
 * at the p99, while freshness held. Most of those computes were repeats: sixty
 * codes are fifteen pools, and a hot pool takes a booking every few seconds.
 *
 * So a refresh is asked of the POOL, and the requests for one pool inside a short
 * window share one compute:
 *
 *   - a quiet pool refreshes at once (the leading edge), as fresh as before;
 *   - a request inside the window, or while a compute runs, waits for ONE trailing
 *     refresh that starts after the window and after the running compute, and that
 *     every later request in the window joins;
 *   - nothing is dropped: every request is covered by a refresh that STARTS after
 *     it. A debounce that skipped a request would lose exactly the booking that
 *     landed during the previous compute, and its time would stay offered until the
 *     lane's four minute backstop.
 *
 * `lastStartedAt` is the slot cache's per pool map that the push path's refresh
 * already debounces on, so a pool the push path refreshed a moment ago counts
 * against the window too, rather than computing twice back to back.
 *
 * Per isolate, by design. Coalescing across isolates would need a shared record
 * read on every booking; within one isolate it costs nothing, and the isolate is
 * where the CPU the load run measured was being spent.
 */

/**
 * How long a pool's bookings share one refresh. Ten seconds collapses a hot pool's
 * bookings (one every few seconds at the load run's sixty a minute) into one compute,
 * while a wait plus a compute (p95 5.2s, worst 10.8s measured) stays inside the
 * thirty second cut Cloudflare applies to work deferred past a response. The cost is
 * that under load a booked time can stay on offer for up to about the window plus a
 * compute, where the lead's confirm is re-verified live anyway (overlaps 0 in every
 * arm of the run).
 */
export const POST_CONFIRM_REFRESH_WINDOW_MS = 10_000;

interface PoolState {
  /** The compute running now, or null. */
  inflight: Promise<void> | null;
  /** The trailing refresh not yet started, which later requests join, or null. */
  pending: Promise<void> | null;
}

export interface PoolRefreshCoalescer {
  /** Ask for `key`'s pool to be refreshed after this moment. Resolves when the
   *  refresh covering this request has finished, and rejects if it failed. */
  request(key: string, run: () => Promise<void>): Promise<void>;
}

export function makePoolRefreshCoalescer(deps: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  windowMs: number;
  /** When each pool's last refresh STARTED, shared with the push path's debounce. */
  lastStartedAt: Map<string, number>;
}): PoolRefreshCoalescer {
  const pools = new Map<string, PoolState>();

  const start = (key: string, state: PoolState, run: () => Promise<void>): Promise<void> => {
    deps.lastStartedAt.set(key, deps.now());
    const running = run();
    // Settled either way, so a waiter behind it never sees its rejection twice.
    const settled: Promise<void> = running.then(
      () => undefined,
      () => undefined,
    );
    state.inflight = settled;
    void settled.then(() => {
      if (state.inflight === settled) state.inflight = null;
    });
    return running;
  };

  return {
    request(key, run) {
      let state = pools.get(key);
      if (!state) {
        state = { inflight: null, pending: null };
        pools.set(key, state);
      }
      // A trailing refresh not yet started will begin after this request: join it.
      if (state.pending) return state.pending;

      const earliest = (deps.lastStartedAt.get(key) ?? -Infinity) + deps.windowMs;
      if (state.inflight === null && deps.now() >= earliest) return start(key, state, run);

      const s = state;
      s.pending = (async () => {
        const wait = earliest - deps.now();
        if (wait > 0) await deps.sleep(wait);
        // Never two computes of one pool side by side: the second would race the
        // first's row write for nothing.
        while (s.inflight) await s.inflight;
        // Cleared BEFORE it starts, so a request arriving while it runs gets a
        // refresh of its own rather than joining one that began before it.
        s.pending = null;
        await start(key, s, run);
      })();
      return s.pending;
    },
  };
}
