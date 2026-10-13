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
 * developers.cloudflare.com/workers/reference/security-model). So a span measures the
 * I/O waits inside it (a Durable Object call, a cache read, a database read) and NOT the
 * CPU after the last I/O. A read slow on CPU therefore shows a small Worker total
 * against a large wait at the canary, which is why the canary's wording names CPU
 * beside transit rather than calling the gap "network".
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
} as const;

export interface ServerTimer {
  /** Run `fn`, recording its duration under `name` whether it resolves or throws. */
  span<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The header value: each span that ran, in order, then the total so far. */
  header(): string;
  /** The total so far, in whole milliseconds. */
  totalMs(): number;
}

const whole = (ms: number) => Math.max(0, Math.round(ms));

/** Start timing now. `now` is injected so a test never waits (L524). */
export function createServerTimer(now: () => number = Date.now): ServerTimer {
  const started = now();
  const spans: Array<[string, number]> = [];
  const totalMs = () => whole(now() - started);
  return {
    async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const s = now();
      try {
        return await fn();
      } finally {
        spans.push([name, whole(now() - s)]);
      }
    },
    totalMs,
    header() {
      return [...spans, [SERVER_TIMING_NAMES.total, totalMs()] as [string, number]]
        .map(([name, dur]) => `${name};dur=${dur}`)
        .join(", ");
    },
  };
}
