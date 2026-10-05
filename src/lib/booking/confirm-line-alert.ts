/**
 * What happens when a confirm cannot use the shared confirm line (#3325): what is
 * logged, and the rare case that pages.
 *
 * A fallback to the isolate's own line is always safe, because the bookings indexes
 * and verify on book still decide, so a fallback is a log line and never a page on
 * its own. A deploy restarts every object and its first answers are `gone`, which is
 * expected on every merge and must never page (L36). What pages is the shared line
 * failing for real, again and again: a switch that is on with no binding to honour
 * it, or calls that are refused or go unanswered, `CONFIRM_LINE_PAGE_AFTER` times
 * within `CONFIRM_LINE_PAGE_WINDOW_MS` on one isolate. An outage reaches every confirm,
 * so it crosses that quickly; one slow call never does.
 *
 * The count is per isolate, deliberately. A count across isolates would need a
 * database write on the confirm path for every fallback, during exactly the outage
 * it reports. Per isolate, a real outage still pages within a few confirms, and the
 * alert store throttles the page across isolates (`sendThrottledAlert`). Off the
 * Workers runtime (a dev server, a node script) it is logged and never pages.
 *
 * Pure: the clock, the runtime check, the log and the page are injected, so
 * scripts/test-confirm-line-alert.ts drives it. Production wiring is in service.ts.
 */
import type { LineReason } from "./shared-confirm-line.ts";

/** Failures inside one window, on one isolate, before it pages. */
export const CONFIRM_LINE_PAGE_AFTER = 3;
/** The window those failures must fall in. */
export const CONFIRM_LINE_PAGE_WINDOW_MS = 60_000;
/** How long the alert store holds the page once sent. */
export const CONFIRM_LINE_ALERT_COOLDOWN_MS = 30 * 60_000;
/** The page's key, catalogued in src/lib/notify/alert-catalog.ts. */
export const CONFIRM_LINE_ALERT_KEY = "confirm_line_unreachable";

/** The page's wording: what happened, what it means for a lead, who acts. */
export function confirmLineUnreachableAlert(reason: LineReason): string {
  const what =
    reason === "unbound"
      ? "The shared confirm line is switched on, but this deployment has no ConfirmLine binding to reach it through"
      : "Confirms cannot reach the shared confirm line right now";
  return (
    `${what}, so each server is using its own line for confirms, as it did before the shared line existed. ` +
    "Bookings still go through and nothing can be double booked, but a crowd of leads asking for the same time " +
    "may be answered slowly or told to try again. An engineer should check the ConfirmLine Durable Object " +
    '(the cause is in the logs under tag=confirm-line); the switch on the admin Hours page turns the shared line off.'
  );
}

/** Counted, never paged: a deploy replacing the object answers `gone`. */
const NEVER_PAGES: ReadonlySet<LineReason> = new Set(["gone", "off", "unread-default", "ok", "abandoned"]);

export function makeReachFailureReporter(deps: {
  now: () => number;
  onWorkers: () => boolean;
  log: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  page: (text: string) => void;
}): (reason: LineReason, err: unknown) => void {
  let recent: number[] = [];
  let paged = false;
  return (reason, err) => {
    deps.log({
      msg: "a confirm could not use the shared confirm line and used its isolate's own",
      reason,
      ...(err ? { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) } : {}),
    });
    if (NEVER_PAGES.has(reason) || !deps.onWorkers()) return;
    const t = deps.now();
    recent = [...recent.filter((at) => t - at < CONFIRM_LINE_PAGE_WINDOW_MS), t];
    if (recent.length < CONFIRM_LINE_PAGE_AFTER || paged) return;
    paged = true;
    deps.page(confirmLineUnreachableAlert(reason));
  };
}
