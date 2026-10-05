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
import { ladderGroupOf } from "@/lib/booking/line-key";
import { peekPoolKey, warmPoolKeys } from "@/lib/availability/slot-cache";

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
 * turn was served, for the `confirm answered` line.
 */
export function confirmLineFor<T>(fallback: ConfirmLine<T>, record: (served: LineServed) => void): ConfirmLine<T> {
  return makeSharedConfirmLine<T>({
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
 * The ladder group a code's confirms share, from the pool grouping this isolate
 * already holds, or null to keep the code's own line (#3325). It never reads: a
 * confirm joins its line before any read. When the grouping is not known yet it is
 * warmed after the response, so the next confirm on this isolate can use it.
 */
export function lineGroupOfLive(code: string): string | null {
  const group = ladderGroupOf(code, peekPoolKey);
  if (group === null) {
    afterResponse("pool-keys-warm", () =>
      warmPoolKeys().catch((err) => {
        log.warn("confirm-line", { msg: "could not warm the pool grouping; confirms keep their code's own line" }, err);
      }),
    );
  }
  return group;
}
