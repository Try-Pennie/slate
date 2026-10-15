import { getCloudflareContext } from "@opennextjs/cloudflare";
import { afterResponse } from "@/lib/after-response";
import { log } from "@/lib/log";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { isWorkersRuntime } from "@/lib/platform/runtime";
import { realTimer } from "@/lib/read-within-deadline";
import type { ConfirmLine } from "@/lib/booking/confirm-queue";
import { CONFIRM_LINE_BINDING } from "@/lib/booking/confirm-line-object";
import {
  makeReachFailureReporter,
  CONFIRM_LINE_ALERT_COOLDOWN_MS,
  CONFIRM_LINE_ALERT_KEY,
} from "@/lib/booking/confirm-line-alert";
import {
  durableLineNamespace,
  makeSharedConfirmLine,
  type DurableLineNamespace,
  type LineNamespace,
  type LineServed,
} from "@/lib/booking/shared-confirm-line";
import { readSharedConfirmLine } from "@/lib/booking/shared-line-switch";
import { ladderGroupRead } from "@/lib/booking/line-key";
import { lineGroupingStore, peekPoolKey, warmPoolKeys } from "@/lib/availability/slot-cache";
import {
  makeGroupingReader,
  lineGroupSourceOf,
  POOL_GROUPING_FETCH_MS,
  POOL_GROUPING_FRESH_MS,
  POOL_GROUPING_RETRY_MS,
  POOL_GROUPING_REFRESH_AHEAD_MS,
} from "@/lib/booking/pool-grouping-reader";
import { groupingDirectoryLive } from "@/lib/booking/pool-grouping-live";
import type { ConfirmLineFacts } from "@/lib/booking/confirm-latency";

/**
 * The shared confirm line, wired to the deployment (#3325): the binding, the stored
 * switch, the alert. The decisions live in the modules it composes, each node tested;
 * this is only where they meet the runtime.
 */

/**
 * The `CONFIRM_LINE` binding, or null where there is none. Off the Workers runtime
 * (`next dev`, a script) there is no request context and no binding, which reads as
 * unbound: a confirm there uses its own line, and the reporter never pages off
 * platform. On the runtime an absent binding is a broken deployment, and with the
 * switch on it is reported as `unbound`.
 */
function lineNamespace(): LineNamespace | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const ns = env[CONFIRM_LINE_BINDING] as DurableLineNamespace | undefined;
    return ns ? durableLineNamespace(ns) : null;
  } catch {
    return null;
  }
}

/** One reporter per isolate, so its window counts this isolate's failures. */
const reportReachFailure = makeReachFailureReporter({
  now: () => Date.now(),
  onWorkers: isWorkersRuntime,
  log: (fields) => log.warn("confirm-line", fields),
  page: (text) =>
    afterResponse("confirm-line-alert", () =>
      // alert-key: confirm_line_unreachable
      sendThrottledAlert(CONFIRM_LINE_ALERT_KEY, CONFIRM_LINE_ALERT_COOLDOWN_MS, text).catch((err) => {
        log.error("confirm-line", { msg: "alert failed" }, err);
      }),
    ),
});

/**
 * The confirm line one request uses: the shared line when the switch is on and the
 * binding answers, else `fallback`, the isolate's own line. `record` receives how each
 * turn was served, for the `confirm answered` line. `trace` (#3354) is the load
 * test's trace for this confirm, which every call to the object then carries, or null
 * for every production confirm. Required, so no call site leaves it out by accident.
 */
export function confirmLineFor<T>(fallback: ConfirmLine<T>, record: (served: LineServed) => void, trace: string | null): ConfirmLine<T> {
  return makeSharedConfirmLine<T>({
    trace,
    namespace: lineNamespace(),
    fallback,
    enabled: readSharedConfirmLine,
    record,
    onReachFailure: reportReachFailure,
    now: () => Date.now(),
    timer: realTimer,
    newId: () => crypto.randomUUID(),
  });
}

/**
 * One reader per server (#3460): a server whose grouping is absent or stale fetches the
 * snapshot the recompute lane published, once however many confirms ask, each waiting at
 * most `POOL_GROUPING_FETCH_MS`. A fetch it STARTS is kept alive past the response
 * (`afterResponse`), because a later confirm on this server may have joined it, and on
 * the platform a request's own I/O can be cancelled when its response goes out. Built on
 * first use rather than at import, so loading this module does no work and reads nothing
 * of the modules it composes.
 */
let reader: ReturnType<typeof makeGroupingReader> | null = null;
const groupingReader = () =>
  (reader ??= makeGroupingReader({
    store: lineGroupingStore,
    directory: () => groupingDirectoryLive(),
    now: () => Date.now(),
    timer: realTimer,
    boundMs: POOL_GROUPING_FETCH_MS,
    freshMs: POOL_GROUPING_FRESH_MS,
    retryMs: POOL_GROUPING_RETRY_MS,
    refreshAheadMs: POOL_GROUPING_REFRESH_AHEAD_MS,
    onFetchStarted: (fetching) => afterResponse("pool-grouping-fetch", () => fetching),
    // #3529: the server's own read, the moment the directory has nothing fresh.
    readOwn: () => warmPoolKeys(),
  }));

/**
 * The confirm's early reads (#3460, #3355 item 1), started after the booking API's key
 * is authenticated, or after the booker's address passes its edge limiter, and never
 * before, so a flood of bad keys or of one address past its minute buys neither
 * (L498). Both then run during the ceilings, the pause flag and the body read, and the
 * confirm awaits them where it needs them: the grouping before its line key
 * (`settleLineGrouping`), the switch when the line decides.
 *
 * Because they start BEFORE the per key and per address hourly ceilings answer, a caller
 * with a good key (or an address inside its minute) whom those ceilings then refuse with
 * a 429 has started them too. What that caller can cause is bounded per SERVER, never
 * per request, however fast it sends:
 *
 * - the switch: the cached reader the line already uses, so at most one read per server
 *   per `SHARED_LINE_SWITCH_TTL_MS` (15s), or per `SHARED_LINE_SWITCH_RETRY_MS` (5s)
 *   while the read is failing, coalesced however many ask;
 * - the grouping: no fetch while the server holds a grouping fresh for more than
 *   `POOL_GROUPING_REFRESH_AHEAD_MS` (#3759), so it also fetches in the last two seconds
 *   of each grouping's life; one in flight
 *   however many ask, a new one only once that is older than `POOL_GROUPING_FETCH_MS`;
 *   and none for `POOL_GROUPING_RETRY_MS` after a fetch that installed nothing.
 *
 * So an over ceiling flood costs a server at most about one switch read every 5 seconds
 * and two directory calls a second, the same as a flood of real confirms would, and
 * nothing more for each request it sends. Each is kept alive past the response
 * (`afterResponse`), because a later confirm on this server may have joined it.
 */
export function startConfirmPrelude(facts: ConfirmLineFacts): void {
  const reading = readSharedConfirmLine();
  afterResponse("shared-line-switch", () => reading);
  facts.groupingStart ??= groupingReader().start();
}

/**
 * Wait, within the bound, for the grouping before the confirm keys its line (#3460).
 * Waits for the fetch the prelude started, or starts one for a confirm that had none,
 * and the bound counts from HERE, where the confirm needs the answer, so slow ceilings
 * between the prelude and this point never spend it (review of #3471).
 * Never throws: how it ended is noted on the facts for the `confirm answered` line.
 */
export async function settleLineGrouping(facts?: ConfirmLineFacts): Promise<void> {
  const reader = groupingReader();
  const reading = await reader.wait(facts?.groupingStart ?? reader.start());
  if (facts) facts.grouping = reading;
}

/**
 * The ladder group a code's confirms share, from the pool grouping this server holds,
 * or null to keep the code's own line (#3325). Synchronous, and a look only: the wait
 * for a grouping this server did not hold happened before the key, in
 * `settleLineGrouping` (#3460, which retires #3325's "a confirm never reads before its
 * line"). Notes on `facts` where the grouping came from, or why there was none
 * (`line_group_source`). When no fresh grouping is held at all it is warmed after the
 * response, so the next confirm on this server can use it.
 */
export function lineGroupOfLive(code: string, facts?: ConfirmLineFacts): string | null {
  const read = ladderGroupRead(code, peekPoolKey);
  if (facts) facts.lineGroupSource = lineGroupSourceOf(read, lineGroupingStore.held(), facts.grouping ?? null);
  if (read.group === null && read.why === "unknown-rung") {
    afterResponse("pool-keys-warm", () =>
      warmPoolKeys().catch((err) => {
        log.warn("confirm-line", { msg: "could not warm the pool grouping; confirms keep their code's own line" }, err);
      }),
    );
  }
  return read.group;
}
