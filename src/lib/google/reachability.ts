import { listCalendars } from "@/lib/google/calendar";
import { log } from "@/lib/log";
import { GoogleHttpError } from "@/lib/google/http-error";
import { reachabilityFromError, type Reachability } from "@/lib/google/reachability-classify";

export type { Reachability } from "@/lib/google/reachability-classify";

/**
 * Bound for the activation reachability probe (#922). The admin 'Make bookable'
 * click waits on this call (and the gate retries it once on a transient
 * failure), so a slow or hanging Google must abort rather than stall the request
 * indefinitely. An abort surfaces as a non-GoogleHttpError, which classifies as
 * transient, feeding the existing retry-then-`google_unverified` path.
 */
export const REACHABILITY_PROBE_TIMEOUT_MS = 8000;

/**
 * Live reachability probe for the bookable activation guard (#281, #913): can
 * Slate reach this agent's Google calendar via domain-wide delegation right now,
 * and if not, is the failure definitive or transient? There is no stored
 * per-agent connection to inspect (DWD mints a token on demand, and the
 * `agent_calendars` rows are written later by the watch cron), so the only way
 * to know at activation time is to try. `listCalendars` mints a delegated token
 * AND hits calendarList, so a gone account (removed from the Workspace,
 * delegation revoked) or a permission failure surfaces as a GoogleHttpError with
 * a definitive status, while a 5xx or a network/timeout error is transient.
 *
 * Returns "reachable" | "gone" | "not-provisioned" | "transient"; the caller decides
 * what to do (block on a definitive failure, retry once then block on a persistent
 * transient). `tag` names the caller in the failure's log line: the placeholder seat
 * check (#4206) runs the same probe from the monitor lane.
 */
export async function classifyCalendarReachability(email: string, tag = "bookable-api"): Promise<Reachability> {
  try {
    await listCalendars(email, REACHABILITY_PROBE_TIMEOUT_MS);
    return "reachable";
  } catch (err) {
    const status = err instanceof GoogleHttpError ? err.status : undefined;
    const kind = reachabilityFromError(err);
    log.warn(tag, {
      msg: "calendar reachability probe failed",
      email,
      status: status ?? null,
      kind,
    });
    return kind;
  }
}
