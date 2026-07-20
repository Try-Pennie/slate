import { listCalendars } from "@/lib/google/calendar";
import { log } from "@/lib/log";

/**
 * Live reachability probe for the bookable activation guard (#281): can Slate
 * actually reach this agent's Google calendar via domain-wide delegation right
 * now? There is no stored per-agent connection to inspect (DWD mints a token on
 * demand, and the `agent_calendars` rows are written later by the watch cron),
 * so the only way to know at activation time is to try. `listCalendars` mints a
 * delegated token AND hits the calendarList endpoint, so a gone account (removed
 * from the Workspace, delegation revoked) or an unreachable calendar API throws.
 *
 * Fail-safe: ANY failure returns false, which blocks the agent from the pool.
 * Better to make an operator retry a deliberate activation than to admit an
 * agent whose calendar the booker can't read (verify-on-book would fail them at
 * confirm time).
 */
export async function isCalendarReachable(email: string): Promise<boolean> {
  try {
    await listCalendars(email);
    return true;
  } catch (err) {
    log.warn("bookable-api", {
      msg: "calendar reachability probe failed",
      email,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
