/**
 * The load run a booking API request belongs to, for scoping the exact hourly ceilings
 * (#3456). No imports, so the load run's drivers send the same header name the Worker
 * reads, on bare node (L41).
 *
 * Why it exists. Since #3416 the booking API's hourly ceilings (6,000 an hour per caller,
 * 1,200 per address) are counted in the `BURST_LIMITER` Durable Object, and since #3310
 * the load test Worker, and the object Worker it binds, are KEPT between runs. Every
 * driver books under one caller, so two runs or two arms inside one hour shared one
 * count, and the reset between arms (`scripts/loadtest/reset.ts`), which empties the
 * `rate_limits` table, no longer reached it. A third arm could meet the ceiling partway
 * through and read as the booking path throttling.
 *
 * Re-keyed rather than cleared. Clearing would need an endpoint on the load test
 * deployment able to delete counter state, which is a write to a security control
 * reachable over HTTP, refused everywhere else only by configuration. Re-keying needs
 * nothing new: a driver names its run (`RUN_ID`, which is unique per dispatch and per
 * attempt) on every request, and under `SLATE_LOADTEST` the ceilings count in an object
 * of that run's own. The old counts are never touched; they age out on the object's own
 * alarm two windows later, as every count does.
 *
 * **It cannot reach production's limiter**, by three independent facts. The header is
 * read only when the caller passes `loadtest: true`, which the authorizer takes from
 * `isLoadtest()` at call time, so production never reads it and no production caller can
 * choose its own key. The load test Worker binds a different object Worker
 * (`slate-burst-limiter-loadtest`, pinned by `scripts/test-burst-limiter-worker.ts`), so
 * even a scoped key lands in a namespace production never reads. And a scope only ever
 * ADDS a prefix to a key, so nothing here can write, clear or lower an existing count.
 */
export const LOADTEST_RUN_HEADER = "x-loadtest-run";

/** What a run id may look like: the workflow's `run-<id>-<attempt>`, or a hand run's own name. */
const RUN_SCOPE = /^[A-Za-z0-9._-]{1,100}$/;

/** The run a request names, or null when it is not to be scoped, with the raw value when unreadable. */
export interface LoadtestRunScope {
  scope: string | null;
  unreadable: string | null;
}

/**
 * The run scope of a request. Off a load test it is ALWAYS null and the header is never
 * read. Under one, a request naming no run is unscoped (a hand run, the canary), and one
 * naming something outside the alphabet is unscoped and returned as `unreadable` so the
 * caller can say so: counting it in some other run's object would be the leak this exists
 * to stop, and silently ignoring it would hide a driver that sends the wrong value.
 */
export function readLoadtestRunScope(
  headers: { get(name: string): string | null },
  loadtest: boolean,
): LoadtestRunScope {
  if (!loadtest) return { scope: null, unreadable: null };
  const raw = headers.get(LOADTEST_RUN_HEADER);
  if (raw === null || raw === "") return { scope: null, unreadable: null };
  return RUN_SCOPE.test(raw) ? { scope: raw, unreadable: null } : { scope: null, unreadable: raw.slice(0, 120) };
}
