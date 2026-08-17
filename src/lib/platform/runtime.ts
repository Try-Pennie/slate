/**
 * Are we actually running on the Cloudflare Workers runtime? (#1525)
 *
 * This exists for exactly one job: deciding whether a failure is EVIDENCE ABOUT
 * PRODUCTION. Slate's server code runs in three places, and only one of them is
 * production:
 *
 *   - the deployed Worker, where the Workers bindings exist and real leads are served;
 *   - `wrangler dev` / `pnpm cf:build` previews, which are the same runtime with the
 *     same bindings (miniflare reports this marker too, and that is correct);
 *   - `next dev` and node scripts, which have NO Workers bindings at all.
 *
 * The third one is the problem. `.env.local` points a dev server at the LIVE Supabase
 * project and the LIVE Slack channel, so anything that alerts pages the real on-call
 * from a laptop. On 2026-08-17 that happened: `rate_limit_broken:availability` paged at
 * 14:44 UTC claiming the only abuse control on the one endpoint reachable by anyone on
 * the internet was off. Production's limiter was enforcing correctly throughout, and
 * Cloudflare's logs held zero `tag=rate-limit` lines across the window against a
 * positive control that returned 101 `tag=recompute` lines. `next.config.ts` does not
 * call `initOpenNextCloudflareForDev`, so `getCloudflareContext()` throws under
 * `next dev`, which the fail-open path could not tell apart from a broken limiter.
 *
 * Why a RUNTIME check and not a match on the error text: an error message is a string
 * the vendor may reword, and branching on message substrings is how a classifier goes
 * quietly wrong (L35). This asks the platform what it is instead. `navigator.userAgent`
 * is Cloudflare's own marker for the Workers runtime, present by default at any
 * compatibility date from 2022-08-31 (ours is 2025-08-01).
 *
 * The safety direction matters. A wrong answer here makes a real production outage go
 * unalerted, so it must not be the only thing standing between a dead limiter and
 * silence: `src/lib/monitor/edge-limiter-health.ts` measures the limiters from inside
 * the deployed Worker every minute and reports the marker it observed, so the
 * assumption is checked against the real target rather than against the documentation
 * (L82) and the hot-path gate has a second route behind it.
 */
const WORKERS_USER_AGENT = "Cloudflare-Workers";

/** True only on the Workers runtime (deployed, or a wrangler/miniflare dev session). */
export function isWorkersRuntime(): boolean {
  return workersRuntimeMarker() === WORKERS_USER_AGENT;
}

/**
 * The raw marker we saw, for reporting rather than deciding.
 *
 * Exposed so the monitor lane can state in its own log what runtime it observed. If
 * Cloudflare ever stops setting this, the marker in a production log line is what
 * reveals it, instead of every limiter alert going quiet with nothing to point at.
 */
export function workersRuntimeMarker(): string | null {
  return globalThis.navigator?.userAgent ?? null;
}
