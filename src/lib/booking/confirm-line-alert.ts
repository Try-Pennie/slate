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
import { makeSustainedFailureGate } from "../notify/sustained-failure.ts";

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
      : reason === "bad-answer"
        ? "The shared confirm line is answering confirms with replies they cannot read"
        : reason === "version"
          ? // #3560: it answered, and said it runs an older build than this app, so the
            // remedy is a redeploy of the line Worker, never a look at whether it is up.
            "The shared confirm line is running an older build than this app and cannot serve its confirms until the ConfirmLine Worker is redeployed at the app's commit"
          : "Confirms cannot reach the shared confirm line right now";
  return pageAround(what);
}

/**
 * The wording for the failures a page was raised over (#3351): one kind keeps that
 * kind's own sentence, and a mix says how many of each, so a page is never worded from
 * the one failure that happened to cross the threshold (L11).
 */
export function confirmLineAlertFor(reasons: readonly LineReason[]): string {
  const kinds = new Set(reasons);
  if (kinds.size === 1) return confirmLineUnreachableAlert(reasons[0]!);
  const count = (pick: (r: LineReason) => boolean) => reasons.filter(pick).length;
  const unbound = count((r) => r === "unbound");
  const unreadable = count((r) => r === "bad-answer");
  const older = count((r) => r === "version");
  const unreachable = reasons.length - unbound - unreadable - older;
  const parts = [
    unreachable > 0 ? `${unreachable} could not reach it` : null,
    unreadable > 0 ? `${unreadable} got a reply ${unreadable === 1 ? "it" : "they"} could not read` : null,
    older > 0 ? `${older} found it running an older build than this app` : null,
    unbound > 0 ? `${unbound} found no ConfirmLine binding to reach it through` : null,
  ].filter((p): p is string => p !== null);
  return pageAround(`Confirms cannot use the shared confirm line right now (of the last ${reasons.length} that failed, ${parts.join(" and ")})`);
}

function pageAround(what: string): string {
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
  // The window and the cooldown are the shared gate's (#3670), the one the rate limiter's
  // fail open pages use too. #3349: it waits out the alert's cooldown and then can page
  // about a later, separate outage; it used to latch for the isolate's life.
  const gate = makeSustainedFailureGate<LineReason>({
    pageAfter: CONFIRM_LINE_PAGE_AFTER,
    windowMs: CONFIRM_LINE_PAGE_WINDOW_MS,
    cooldownMs: CONFIRM_LINE_ALERT_COOLDOWN_MS,
  });
  return (reason, err) => {
    deps.log({
      msg: "a confirm could not use the shared confirm line and used its isolate's own",
      reason,
      ...(err ? { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) } : {}),
    });
    if (NEVER_PAGES.has(reason) || !deps.onWorkers()) return;
    const verdict = gate.record(CONFIRM_LINE_ALERT_KEY, deps.now(), reason);
    if (verdict.page) deps.page(confirmLineAlertFor(verdict.recent()));
  };
}
