/**
 * How fresh the isolate serving a request is (#3713).
 *
 * Lead availability reads spend about half a second inside the Worker every evening,
 * on cached times, and the leading guess is fresh isolates paying to load Slate's code.
 * That guess has been made before and was wrong (#2340, L699), so each read now carries
 * the facts that settle it rather than a difference to infer it from.
 *
 * Two counts, because they answer different questions:
 *
 *   - the ISOLATE's runs of the app, counted at the Worker for every way it runs the app
 *     (an HTTP request, a cron tick, a log shipping receipt; `worker/app-invocations.ts`,
 *     #3354), with the time of its first run. A read that is run 1 of its isolate paid
 *     for the isolate starting.
 *   - the ROUTE's own requests, counted in the route module, every one of them
 *     whatever it answered (a 404 or a 429 ran the module too). Next loads a route's code on
 *     its first request, so an isolate warmed by a cron tick can still be evaluating the
 *     availability route for the first time.
 *
 * The isolate's record lives on `globalThis` under a registered symbol because the
 * Worker entry and the app are separate bundles in ONE isolate: each holds its own copy
 * of this module, and the global is the only thing both see. One record, one writer
 * (`recordIsolateRun`), so the count the load test stamps and the one a lead's read logs
 * cannot drift apart (L83). Nothing a caller sends can reach it, unlike a header.
 *
 * Reading it races other requests the isolate is serving at the same moment, so
 * `isolateRuns` is the runs SO FAR when the read reached the route, this one included,
 * not this request's own index. At one or two lead reads a minute that is the same
 * number; under a burst it can only read higher, never as fresher than it was.
 */

const KEY = Symbol.for("slate.isolate-runs");

export interface IsolateRunRecord {
  /** Runs of the app this isolate has made, the current one included. */
  runs: number;
  /** When the first of them started, on the Worker's clock. */
  firstRunAtMs: number;
}

type Host = Record<symbol, unknown>;

/**
 * Count a run of the app. Returns its index in the isolate (0 for the first). Called
 * by the Worker's one wrapper around the app and nowhere else.
 */
export function recordIsolateRun(nowMs: number, host: object = globalThis): number {
  const h = host as Host;
  const rec = readIsolateRuns(host);
  if (rec === null) {
    h[KEY] = { runs: 1, firstRunAtMs: nowMs } satisfies IsolateRunRecord;
    return 0;
  }
  h[KEY] = { runs: rec.runs + 1, firstRunAtMs: rec.firstRunAtMs } satisfies IsolateRunRecord;
  return rec.runs;
}

/** The isolate's record, or null when nothing recorded one or it is unreadable. */
export function readIsolateRuns(host: object = globalThis): IsolateRunRecord | null {
  const v = (host as Host)[KEY];
  if (typeof v !== "object" || v === null) return null;
  const { runs, firstRunAtMs } = v as Partial<IsolateRunRecord>;
  if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs < 1) return null;
  if (typeof firstRunAtMs !== "number" || !Number.isFinite(firstRunAtMs)) return null;
  return { runs, firstRunAtMs };
}

export interface IsolateFreshness {
  /** The isolate's runs of the app so far, this one included; null outside the Worker. */
  isolateRuns: number | null;
  /** Since the isolate's first run; null outside the Worker. */
  isolateAgeMs: number | null;
  /** The route's own requests in this isolate, whatever they answered, this one included. */
  routeRequests: number;
}

/**
 * A reader for one route. Make it once at the route module's scope and call it first
 * thing in every request, before any branch can return: the count it keeps is that
 * module's, which is the point (see the header).
 */
export function makeFreshnessReader(host: object = globalThis): (nowMs: number) => IsolateFreshness {
  let requests = 0;
  return (nowMs) => {
    requests += 1;
    const rec = readIsolateRuns(host);
    return {
      isolateRuns: rec?.runs ?? null,
      isolateAgeMs: rec ? Math.max(0, nowMs - rec.firstRunAtMs) : null,
      routeRequests: requests,
    };
  };
}
