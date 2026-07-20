import { listCalendars } from "@/lib/google/calendar";
import { log } from "@/lib/log";
import { GoogleHttpError } from "@/lib/google/http-error";
import { reachabilityFromError, type Reachability } from "@/lib/google/reachability-classify";

export type { Reachability } from "@/lib/google/reachability-classify";

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
 * Returns "reachable" | "gone" | "transient"; the caller decides what to do
 * (block on gone, retry once then block on persistent transient).
 */
export async function classifyCalendarReachability(email: string): Promise<Reachability> {
  try {
    await listCalendars(email);
    return "reachable";
  } catch (err) {
    const status = err instanceof GoogleHttpError ? err.status : undefined;
    const kind = reachabilityFromError(err);
    log.warn("bookable-api", {
      msg: "calendar reachability probe failed",
      email,
      status: status ?? null,
      kind,
    });
    return kind;
  }
}
