/**
 * The ONE way the Worker runs the app, so every run of it is counted (#3354).
 *
 * A fresh isolate's first request is told apart by how many times the isolate has
 * run the app before it. The first version counted HTTP fetches only, and the Worker
 * runs the app three ways: an HTTP request, a cron tick (`scheduled()` drives the
 * app's cron routes) and a log shipping receipt. An isolate whose first job was a
 * cron tick had already evaluated the app, and its first HTTP request still read as
 * the first (#3358 review). So the count lives here, every call into the app goes
 * through `fetch` below, and `workerAppCallsOutsideWrapper` fails the build on a call
 * that skips it (scripts/test-worker-app-invocations.ts).
 *
 * Under the load test an HTTP request also carries the Worker's entry stamp and its
 * invocation index to the route (`withEntryMarks`); off the load test nothing is
 * stamped. The count itself is the isolate's one record (`recordIsolateRun`, #3713),
 * which the availability route reads on every lead's read.
 */
import { withEntryMarks } from "@/lib/booking/wait-marks";
import { recordIsolateRun } from "@/lib/api/isolate-runs";

/** As much of the OpenNext handler as the Worker calls. */
export interface AppHandler<Env, Ctx> {
  fetch(request: Request, env: Env, ctx: Ctx): Response | Promise<Response>;
}

export interface CountedApp<Env, Ctx> {
  /**
   * Run the app. `stamp` is given on the HTTP path only: when the Worker was entered
   * and whether this is the load test, in which case the request carries both facts.
   */
  fetch(request: Request, env: Env, ctx: Ctx, stamp?: { loadtest: boolean; enteredAtMs: number }): Response | Promise<Response>;
}

export function countedApp<Env, Ctx>(handler: AppHandler<Env, Ctx>): CountedApp<Env, Ctx> {
  return {
    fetch(request, env, ctx, stamp) {
      // #3713: the count lives in the isolate's one record, which the availability route
      // also reads for every lead's read, so the two can never be different counts.
      const invocationIndex = recordIsolateRun(stamp?.enteredAtMs ?? Date.now());
      const req = stamp
        ? withEntryMarks(request, { loadtest: stamp.loadtest, nowMs: stamp.enteredAtMs, invocationIndex })
        : request;
      return handler.fetch(req, env, ctx);
    },
  };
}

/**
 * Every direct call to the app's handler in the Worker's source, which must be none:
 * each one is a run of the app the count above cannot see.
 */
export function workerAppCallsOutsideWrapper(source: string): string[] {
  return [...source.matchAll(/\bhandler\.fetch\s*\(/g)].map((m) => {
    const line = source.slice(0, m.index).split("\n").length;
    return `worker/index.ts:${line}`;
  });
}
