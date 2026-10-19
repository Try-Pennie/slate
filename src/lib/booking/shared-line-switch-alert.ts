/**
 * The shared confirm line switch's failed reads, counted rather than only logged (#3339).
 *
 * A confirm reads `booking_settings.shared_confirm_line` through a per isolate cache
 * (`shared-line-switch-core.ts`), and a read that fails or misses its deadline answers
 * the last value this server read, or with none the deployment default. That is the right
 * thing to SERVE, and until #3339 it was also the only thing that happened: a log line.
 * So a database refusing that read for an hour left every cold server on the deployment
 * default (off in production until #3339 turned it on), with nothing anybody would see
 * (L77). Whichever way the default points, a server standing on it is not reading the
 * switch an admin set, and that is what the page reports.
 *
 * The shape is the shared line's own fallback page (`confirm-line-alert.ts`) and the
 * rate limiter's (#3670), on the same gate: one failed read is a finished event and never
 * a page (L36), while `SWITCH_READ_PAGE_AFTER` of them on one server inside
 * `SWITCH_READ_PAGE_WINDOW_MS` is what an outage looks like from inside that server, and
 * pages once per cooldown. Counted per isolate, never in a shared store, because the store
 * most likely to be failing is the database this read is failing against (L345). Off the
 * Workers runtime (a dev server, a node script) it is logged and never pages.
 *
 * An incident, not a condition: it names reads already answered, and a later read that
 * works calls nothing that could clear it without putting a database write on the
 * confirm path. The ongoing state, a switch nobody can read, is measured by the monitor
 * lane's own read of it every tick (`shared_confirm_line_left_off`), whose failure the step
 * boundary pages under `monitor_step_failing`, with an all clear.
 *
 * Pure: the clock, the runtime check, the log, the page and the default are injected, so
 * scripts/test-shared-line-switch-alert.ts drives it. Production wiring is in
 * `shared-line-switch.ts`.
 */
import { makeSustainedFailureGate } from "../notify/sustained-failure.ts";
import { parseSharedLineDefault, SHARED_LINE_SWITCH_RETRY_MS } from "./shared-line-switch-core.ts";

/** The page's key, catalogued in src/lib/notify/alert-catalog.ts. */
export const SWITCH_READ_ALERT_KEY = "shared_line_switch_unreadable";
/** Failed reads inside one window, on one server, before it pages. */
export const SWITCH_READ_PAGE_AFTER = 3;
/**
 * The window those failures must fall in. A server retries a failed read no sooner than
 * `SHARED_LINE_SWITCH_RETRY_MS` after it, so a run of `SWITCH_READ_PAGE_AFTER` needs at
 * least two of those spacings; a minute holds that with room, and is the confirm line's
 * own fallback window.
 */
export const SWITCH_READ_PAGE_WINDOW_MS = Math.max(60_000, 3 * (SWITCH_READ_PAGE_AFTER - 1) * SHARED_LINE_SWITCH_RETRY_MS);
/** How long one server stays quiet once it has paged. */
export const SWITCH_READ_ALERT_COOLDOWN_MS = 30 * 60_000;

/** What a page counted: how many, over what window, and whether that is a floor. */
export interface MeasuredReadFailures {
  count: number;
  windowMs: number;
  atLeast: boolean;
}

/** The deployment default in words, from its raw value, read when the page is worded. */
function defaultInWords(raw: string | undefined): string {
  const parsed = parseSharedLineDefault(raw);
  if (parsed.problem?.kind === "missing") return "the deployment default, which is not set and so means off";
  if (parsed.problem?.kind === "unrecognised") return "the deployment default, which is neither on nor off and so means off";
  return `the deployment default, which is ${parsed.on ? "on" : "off"}`;
}

/**
 * The page: what was counted (only that), what the server answered instead, what that
 * means for a lead, and where the cause is. Never the raw error (the logs hold it).
 */
export function sharedLineSwitchUnreadableAlert(m: MeasuredReadFailures, rawDefault: string | undefined): string {
  const minutes = Math.max(1, Math.round(m.windowMs / 60_000));
  const span = minutes === 1 ? "the last minute" : `the last ${minutes} minutes`;
  const count = `${m.atLeast ? "At least " : ""}${m.count} ${m.count === 1 ? "read" : "reads"}`;
  // #3339: which way a server on the default can be wrong depends on the default, so the
  // consequence is derived from the same parse the sentence names (L180).
  const wrongWay = parseSharedLineDefault(rawDefault).on
    ? "may put a crowd through the shared line even if somebody switched it off"
    : "may line a crowd up on its own rather than across every server";
  return (
    `${count} of the shared confirm line switch failed on one server in ${span}, so its confirms used the last ` +
    `value it had read, or with none ${defaultInWords(rawDefault)}, which may not be how the switch on the admin ` +
    `business hours page is set. Bookings still go through and nothing can be double booked, but a server on the wrong answer ` +
    `${wrongWay}. An engineer should check why ` +
    "booking_settings cannot be read (the cause is in the logs under tag=shared-line)."
  );
}

/** One failed read: logged always, counted, and paged on a sustained run. */
export function makeSwitchReadFailureReporter(deps: {
  now: () => number;
  onWorkers: () => boolean;
  /** The error goes as its own argument, so the log serializes it whole. */
  log: (fields: Record<string, string | number | boolean | null | undefined>, err: unknown) => void;
  page: (text: string) => void;
  /** The deployment default's raw value, read when the page is worded, never at module load. */
  deploymentDefault: () => string | undefined;
}): (err: unknown) => void {
  const gate = makeSustainedFailureGate<true>({
    pageAfter: SWITCH_READ_PAGE_AFTER,
    windowMs: SWITCH_READ_PAGE_WINDOW_MS,
    cooldownMs: SWITCH_READ_ALERT_COOLDOWN_MS,
  });
  return (err) => {
    // Off the runtime nothing is counted, because nothing is about production.
    const verdict = deps.onWorkers() ? gate.record(SWITCH_READ_ALERT_KEY, deps.now(), true) : null;
    deps.log(
      {
        msg: "shared confirm line switch unreadable, answering the last value read, or the deployment default with none",
        in_window: verdict?.inWindow ?? null,
      },
      err,
    );
    if (verdict?.page) {
      deps.page(sharedLineSwitchUnreadableAlert({ count: verdict.inWindow, windowMs: SWITCH_READ_PAGE_WINDOW_MS, atLeast: verdict.truncated }, deps.deploymentDefault()));
    }
  };
}
