/**
 * Advisors the confirm's ladder read leaves out (#3530).
 *
 * The ladder read (`ladderInputsFrom`, #3489) drops an advisor whose rows it cannot
 * read rather than failing every confirm in the org, and drops them WHOLE, because
 * skipping only the bad row would let a busy block, hold or count go missing and the
 * advisor be booked over a call they already have. That keeps leads safe and makes the
 * advisor unbookable with nothing saying so: their buckets go on offering times through
 * everybody else, so no screen reads as broken. Somebody has to repair the row, so this
 * pages while anybody is left out.
 *
 * It asks the confirm's OWN reader, through the same request a confirm makes, rather
 * than re-checking the rows with a second copy of its rules, so the page can only ever
 * name the advisors confirms are leaving out (L263). What it cannot see, so a quiet
 * pass is never read as more than it is (L400): busy time, holds and counts are read
 * over the window around the moment of the check, so a bad row of that kind on another
 * day is found only when a confirm or a check reaches that day. The roster rows (the
 * advisor, their bucket memberships, their hours and zone) are read whole every time.
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { DroppedAdvisor } from "../availability/ladder-inputs.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const LADDER_DROPPED_KEY = "ladder_advisor_unreadable";

const NAME_CAP = 8;

/** Each section of the read, as what a person would go and fix. */
const WHAT: Record<string, string> = {
  agents: "their profile (email, teams or org)",
  members: "a bucket membership",
  schedules: "their working hours or time zone",
  busy: "a busy time on their calendar",
  day_counts: "their count of calls for a day",
  holds: "a reroute hold",
  shares: "a past routed booking",
};

function what(why: readonly string[]): string {
  const sections = [...new Set(why.map((w) => w.slice(0, w.indexOf(":"))))];
  return sections.map((s) => WHAT[s] ?? s).join(", ");
}

function who(a: DroppedAdvisor): string {
  return `${a.name ?? a.id}: ${what(a.why)}`;
}

/**
 * The page. It says what a lead never sees (the advisor is offered to nobody) and what
 * repairs it: correcting the row, after which the next pass ends the page by itself.
 */
export function formatLadderDroppedAlert(advisors: readonly DroppedAdvisor[]): string {
  const n = advisors.length;
  const lines = advisors.slice(0, NAME_CAP).map(who);
  const more = n > NAME_CAP ? `\n(and ${n - NAME_CAP} more)` : "";
  return (
    `${n} ${n === 1 ? "advisor is" : "advisors are"} left out of every booking, because something Slate reads to ` +
    `judge whether they are free could not be read. Leaving them out keeps them from being booked over a call ` +
    `they already have; until it is corrected no lead is offered their diary, and their buckets carry on with ` +
    `everybody else. Correct what is named under admin > agents (or the record behind it), and the next check ` +
    `ends this.\n` +
    lines.join("\n") +
    more
  );
}

/** The all clear, hung off a read that answered and left nobody out. */
export function formatLadderDroppedRecovery(): string {
  return "Every bookable advisor can be judged again, so nobody is left out of booking. No action is needed.";
}

export type LadderDroppedResult = { status: "dropped"; advisors: readonly DroppedAdvisor[] } | { status: "clear" };

export interface LadderDroppedDeps {
  /** The advisors the confirm's ladder read leaves out right now. THROWS when it cannot read. */
  read: () => Promise<readonly DroppedAdvisor[]>;
  notify: ThrottledNotify;
  /** REQUIRED, so a condition cannot be wired with no way to end it (#1151). */
  resolve: AlertResolve;
  cooldownMs: number;
}

/**
 * Read, then page or clear. A read that throws is NOT caught: it measured nothing, so it
 * may page nothing and clear nothing (#1134, #1152), and letting it fail the step is
 * what makes a check that has stopped working page as one (`monitor_step_failing`).
 * A failed send is swallowed, because a flaky Slack must never fail the tick.
 */
export async function runLadderDroppedCheck(deps: LadderDroppedDeps): Promise<LadderDroppedResult> {
  const advisors = await deps.read();
  if (advisors.length > 0) {
    await deps.notify(LADDER_DROPPED_KEY, deps.cooldownMs, formatLadderDroppedAlert(advisors)).catch(logAlertSendFailure(LADDER_DROPPED_KEY));
    return { status: "dropped", advisors };
  }
  await deps.resolve(LADDER_DROPPED_KEY, formatLadderDroppedRecovery()).catch(logResolveFailure(LADDER_DROPPED_KEY));
  return { status: "clear" };
}
