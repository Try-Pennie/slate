/**
 * A `Server-Timing` header for a route's own elapsed time (#3653, for #3652).
 *
 * The latency canary times `/api/availability` from a GitHub runner, so what it sees is
 * the Worker's time plus the network's, and on 2026-10-12 nothing could separate the
 * two: a cached read took over a second at the canary and no record said where. This
 * lets a response say how long the Worker itself thought it took, with named spans for
 * the parts worth telling apart.
 *
 * What the number is, honestly: on Cloudflare Workers `Date.now()` returns the time of
 * the last I/O and does not advance while code runs (a Spectre mitigation, see
 * developers.cloudflare.com/workers/reference/security-model). Three consequences, and
 * every reader of these numbers needs all three:
 *
 *   - a span ends at its own LAST I/O, so CPU it spends after that is in no span;
 *   - a span starts at the clock's frozen value, which is the PREVIOUS I/O's finish, so
 *     CPU spent between that I/O and the span starting is counted inside it. The first
 *     span of a request therefore carries the CPU spent since the last I/O before the
 *     handler began, which on an isolate meeting the route for the first time can
 *     include loading the route's code;
 *   - a span with no I/O inside it reads 0 whatever CPU it spent. `hours;dur=0` means
 *     the business hours came from the isolate's own cache, not that reading them was
 *     free.
 *
 * So a span is I/O waits plus some CPU, never CPU alone, and a read that is slow on CPU
 * after its last I/O shows a small Worker total against a large wait at the canary.
 * That is why the canary's wording names CPU beside transit rather than calling the gap
 * "network", and why a CPU bound gap is never presented as measured (#3713).
 *
 * Imports nothing, so `scripts/test-server-timing.ts` can drive it beside the canary's
 * parser (which runs on bare node and keeps its own copy of the names) and fail if the
 * two stop agreeing.
 */

/** The entry names the route writes. The canary reads exactly these (latency-slo.ts). */
export const SERVER_TIMING_NAMES = {
  /** Everything from the start of the handler to the response, on the Worker's clock. */
  total: "worker",
  /** The burst limiter call (`availabilityWithinLimit`). */
  limiter: "limit",
  /** The slot read (`getBucketSlotsWithFallback`), cache tiers and any fallback included. */
  slots: "slots",
  /**
   * #3713: the parts INSIDE `slots`, so a slow cached read can be told apart by which
   * read it waited on. Each is summed over every time the part ran on the request's
   * own bucket; a part that never ran is absent rather than 0.
   */
  /** The edge cache (Cache API): the lookup, and the write back after a stored row read. */
  cache: "cache",
  /** The org's business hours (`loadBusinessHoursCached`): the served filter and the offered window. */
  hours: "hours",
  /** The stored `bucket_slots` row, read when the edge cache missed. */
  row: "row",
  /** A live compute and its self heal write, when no good stored row existed. */
  compute: "compute",
  /** Every lower tier read by the tier fallback walk, whole (their own parts are not split). */
  fallback: "fallback",
} as const;

export interface ServerTimer {
  /**
   * Run `fn`, recording its duration under `name` whether it resolves or throws. A name
   * recorded more than once holds the SUM, in the place it first finished.
   */
  span<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The header value: each name that ran, in order, then the total so far. */
  header(): string;
  /** The total so far, in whole milliseconds. */
  totalMs(): number;
  /** What `name` recorded, in whole milliseconds, or null when it never ran (L90). */
  spanMs(name: string): number | null;
}

/** As much of a timer as code that only records spans needs. */
export type SpanTimer = Pick<ServerTimer, "span">;

const whole = (ms: number) => Math.max(0, Math.round(ms));

/** Start timing now. `now` is injected so a test never waits (L524). */
export function createServerTimer(now: () => number = Date.now): ServerTimer {
  const started = now();
  // A Map keeps insertion order, so a name stays where it first finished.
  const spans = new Map<string, number>();
  const totalMs = () => whole(now() - started);
  return {
    async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const s = now();
      try {
        return await fn();
      } finally {
        spans.set(name, (spans.get(name) ?? 0) + Math.max(0, now() - s));
      }
    },
    totalMs,
    spanMs: (name) => {
      const ms = spans.get(name);
      return ms === undefined ? null : whole(ms);
    },
    header() {
      return [...[...spans].map(([name, ms]) => [name, whole(ms)] as const), [SERVER_TIMING_NAMES.total, totalMs()] as const]
        .map(([name, dur]) => `${name};dur=${dur}`)
        .join(", ");
    },
  };
}
