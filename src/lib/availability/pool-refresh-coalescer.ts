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

interface PoolState<R extends string> {
  /** The compute running now, or null. */
  inflight: Promise<void> | null;
  /** The trailing refresh not yet started, which later requests join, or null. */
  pending: Promise<void> | null;
  /** The codes the pending refresh covers, one per booking that joined it. */
  pendingCodes: Set<string>;
  /** Why each request joined the pending refresh (#3381), once each. */
  pendingReasons: Set<R>;
}

/**
 * The refresh itself, handed EVERY code it covers (#3293 review). It must resolve
 * the pools from those codes when it runs, never from the first requester's alone:
 * a bucket can change pools inside the window, and a joiner whose code is still in
 * the pool must still get its pool refreshed.
 */
export type PoolRefresh<R extends string = string> = (codes: string[], reasons: R[]) => Promise<void>;

export interface PoolRefreshCoalescer<R extends string = string> {
  /** Ask for the pool `key` (which `code` is in) to be refreshed after this moment.
   *  Resolves when the refresh covering this request has finished, and rejects if
   *  it failed. `reason` is why it was asked (#3381): the refresh is handed every
   *  reason it covers, so the row it writes names everybody it was written for,
   *  never only the first requester. */
  request(key: string, code: string, reason: R, run: PoolRefresh<R>): Promise<void>;
  /** How many keys it holds state for, so a test can see idle ones are evicted. */
  trackedKeys(): number;
  /** Forget every key, for tests that must not inherit another case's state. */
  reset(): void;
}

export function makePoolRefreshCoalescer<R extends string = string>(deps: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  windowMs: number;
  /** When each pool's last refresh STARTED, shared with the push path's debounce. */
  lastStartedAt: Map<string, number>;
}): PoolRefreshCoalescer<R> {
  const pools = new Map<string, PoolState<R>>();

  const start = (key: string, state: PoolState<R>, run: PoolRefresh<R>, codes: string[], reasons: R[]): Promise<void> => {
    deps.lastStartedAt.set(key, deps.now());
    const running = run(codes, reasons);
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

  /**
   * Drop every key with nothing in hand whose window has passed (#3293 review). Such
   * a key can neither be joined nor debounce anyone, so keeping it only grows the
   * maps, and the fallback keys for unknown codes would otherwise accumulate for the
   * isolate's life. Its start time goes too: the push path's own debounce is two
   * seconds, well inside the window, so an entry older than the window is one it
   * would never act on.
   */
  const evictIdle = (keep: string) => {
    const now = deps.now();
    for (const [key, state] of pools) {
      if (key === keep || state.pending !== null || state.inflight !== null) continue;
      if (now - (deps.lastStartedAt.get(key) ?? -Infinity) < deps.windowMs) continue;
      pools.delete(key);
      deps.lastStartedAt.delete(key);
    }
  };

  return {
    trackedKeys: () => pools.size,
    reset: () => pools.clear(),
    request(key, code, reason, run) {
      evictIdle(key);
      let state = pools.get(key);
      if (!state) {
        state = { inflight: null, pending: null, pendingCodes: new Set(), pendingReasons: new Set() };
        pools.set(key, state);
      }
      // A trailing refresh not yet started will begin after this request: join it,
      // adding this booking's code to the ones it covers.
      if (state.pending) {
        state.pendingCodes.add(code);
        state.pendingReasons.add(reason);
        return state.pending;
      }

      const earliest = (deps.lastStartedAt.get(key) ?? -Infinity) + deps.windowMs;
      if (state.inflight === null && deps.now() >= earliest) return start(key, state, run, [code], [reason]);

      const s = state;
      s.pendingCodes = new Set([code]);
      s.pendingReasons = new Set([reason]);
      s.pending = (async () => {
        const wait = earliest - deps.now();
        if (wait > 0) await deps.sleep(wait);
        // Never two computes of one pool side by side: the second would race the
        // first's row write for nothing.
        while (s.inflight) await s.inflight;
        // Cleared BEFORE it starts, so a request arriving while it runs gets a
        // refresh of its own rather than joining one that began before it.
        s.pending = null;
        const codes = [...s.pendingCodes];
        const reasons = [...s.pendingReasons];
        s.pendingCodes = new Set();
        s.pendingReasons = new Set();
        await start(key, s, run, codes, reasons);
      })();
      return s.pending;
    },
  };
}
