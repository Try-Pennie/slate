// Relative value imports so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { DateTime } from "luxon";
import { formatClockTime } from "../date/parse.ts";
import { formatWhenLine, normalizeTzLabel } from "./core.ts";
import { openSpansText, type OooEventMismatch } from "./alert-copy.ts";

/**
 * The Slack messages an agent and their manager read when an approved time off and
 * the agent's Google Calendar stop matching, and the ones that say it is over (#3372).
 *
 * Every time is in the zone the agent submitted the request in, which is the zone
 * their approval message used, so the two read alike. None of these reads the clock:
 * a moment is passed in, so the preview renders the same words every day.
 *
 * Neither message says which side is wrong. On 2026-10-06 the edit in Google was the
 * true one (the agent was working that morning), so both fixes are offered, and the
 * approved hours are said to be still blocked so nobody rushes to protect them.
 */

const NOT_BLOCKING_WHY = "it may have been deleted, declined, marked free or moved";

function whenOf(f: Pick<OooEventMismatch, "startsAt" | "endsAt" | "displayTzId" | "displayTzLabel">): string {
  return formatWhenLine(f.startsAt, f.endsAt, f.displayTzId, f.displayTzLabel ?? undefined);
}

/** What the calendar shows for one finding, in the request's zone. */
function calendarSays(f: OooEventMismatch, whose: string): string {
  const label = f.displayTzLabel ?? undefined;
  if (f.coverage.kind === "uncovered") {
    return `${whose} calendar leaves ${openSpansText(f.coverage.spans, f.displayTzId, label)} open.`;
  }
  if (f.coverage.unmeasured !== null) {
    const checked = formatWhenLine(f.startsAt, new Date(f.coverage.unmeasured.startMs).toISOString(), f.displayTzId, label);
    return `${whose} calendar shows no time off event for ${checked} (${NOT_BLOCKING_WHY}).`;
  }
  return `${whose} calendar shows no time off event for it (${NOT_BLOCKING_WHY}).`;
}

/** A moment, in the request's zone: `Tue, Oct 6 2026 at 9:05 am MT`. */
function momentIn(ms: number, tzId: string, tzLabel: string | null): string {
  const zone = DateTime.fromMillis(ms, { zone: tzId }).isValid ? tzId : "Etc/UTC";
  const dt = DateTime.fromMillis(ms, { zone });
  return `${dt.toFormat("ccc, LLL d yyyy")} at ${formatClockTime(dt) ?? ""} ${normalizeTzLabel(zone, tzLabel ?? undefined)}`;
}

/**
 * The first message, to the agent. One message for every request found together, so
 * an agent with two is not sent two.
 */
export function agentMismatchDm(found: OooEventMismatch[], appBaseUrl: string): string {
  const one = found.length === 1;
  const lines = found.map((f) => `Approved: ${whenOf(f)}. ${calendarSays(f, "Your")}`);
  return (
    `Your Google Calendar no longer matches ` +
    `${one ? "your approved time off" : `${found.length} approved time off requests of yours`}.\n` +
    `${lines.join("\n")}\n` +
    `Those approved hours are still blocked, so no calls will be booked into them while you sort it out. ` +
    `To fix it, do one of these:\n` +
    `If you are off then, put your calendar event back to the approved times.\n` +
    `If you are working those hours, change the request in <${appBaseUrl}/me/time-off|My time off>. ` +
    `It goes back to your manager to approve.`
  );
}

/** One request as the manager reads it, with whether a call is already booked in the gap. */
export interface ManagerMismatchItem {
  finding: OooEventMismatch;
  bookedInGap: boolean;
}

/**
 * The second message, to the agent's manager, once the agent's wait is over. Names the
 * agent, each request and the hours left open, and says when the agent was told, or
 * that their message could not be delivered, in which case the manager hears first.
 */
export function managerMismatchDm(input: {
  agentName: string;
  items: ManagerMismatchItem[];
  /** When the agent was told; `atMs` null when that record's stamp could not be read. */
  agentTold: { atMs: number | null } | "unreachable";
  appBaseUrl: string;
}): string {
  const { agentName, items, agentTold, appBaseUrl } = input;
  const first = items[0]!.finding;
  const one = items.length === 1;
  const what = one ? "an approved time off" : `${items.length} approved time off requests`;
  const history =
    agentTold === "unreachable"
      ? `The message telling ${agentName} could not be delivered, so you are hearing first.`
      : agentTold.atMs === null
        ? `${agentName} was asked to fix it and it has not changed since.`
        : `${agentName} was asked to fix it on ${momentIn(agentTold.atMs, first.displayTzId, first.displayTzLabel)} ` +
          `and it has not changed since.`;
  const lines = items.map(
    ({ finding: f, bookedInGap }) =>
      `Approved: ${whenOf(f)}. ${calendarSays(f, "The")}` +
      (bookedInGap ? " A call is already booked inside those hours." : "") +
      ` <${appBaseUrl}/admin/ooo?request=${f.requestId}|Open the request>`,
  );
  return (
    `${agentName}'s Google Calendar does not match ${what}. ${history}\n` +
    `${lines.join("\n")}\n` +
    `The approved hours are still blocked, so no new calls will be booked into them. ` +
    `Please check with ${agentName} which is right: if those hours are being worked, the request ` +
    `needs changing in My time off and comes back for approval; if not, the calendar event needs ` +
    `putting back to the approved times.`
  );
}

/**
 * Why a request no longer needs anybody. `agreed`: the calendar and the request match
 * again (whichever side was changed). The rest come from the request leaving the
 * approved set: `changed` is back with the manager as pending, `gone` is a request
 * whose row could not be read back, so it claims nothing beyond that.
 */
export type ClearedWhy = "agreed" | "changed" | "cancelled" | "declined" | "passed" | "gone";

export interface ClearedTimeOff {
  why: ClearedWhy;
  /** The request's window, or null when it could not be read back (`gone`). */
  when: { startsAt: string; endsAt: string; displayTzId: string; displayTzLabel: string | null } | null;
}

const windowOf = (c: ClearedTimeOff) => (c.when ? whenOf(c.when) : null);

/** The all-clear to the agent. */
export function agentMismatchClearedDm(c: ClearedTimeOff): string {
  const w = windowOf(c);
  const yours = w ? `Your time off for ${w}` : "That time off";
  switch (c.why) {
    case "agreed":
      return `Thanks, your Google Calendar matches your approved time off for ${w ?? "those dates"} again. Nothing more to do.`;
    case "changed":
      return `${yours} was changed and is back with your manager to approve, so there is nothing more to fix on your calendar for now.`;
    case "cancelled":
      return `${yours} was cancelled, so there is nothing left to fix on your calendar.`;
    case "declined":
      return `${yours} was declined, so there is nothing left to fix on your calendar.`;
    case "passed":
      return `${yours} has passed, so there is nothing left to fix on your calendar.`;
    case "gone":
      return `${yours} is no longer approved, so there is nothing left to fix on your calendar.`;
  }
}

/** The all-clear to the manager who was told. */
export function managerMismatchClearedDm(agentName: string, c: ClearedTimeOff): string {
  const w = windowOf(c);
  const theirs = w ? `${agentName}'s time off for ${w}` : `That time off of ${agentName}'s`;
  switch (c.why) {
    case "agreed":
      return `${agentName}'s Google Calendar and approved time off for ${w ?? "those dates"} match again. Nothing more to do.`;
    case "changed":
      return `${theirs} was changed and is waiting for approval again, so there is nothing to fix on the calendar for now.`;
    case "cancelled":
      return `${theirs} was cancelled, so there is nothing left to fix.`;
    case "declined":
      return `${theirs} was declined, so there is nothing left to fix.`;
    case "passed":
      return `${theirs} has passed, so there is nothing left to fix.`;
    case "gone":
      return `${theirs} is no longer approved, so there is nothing left to fix.`;
  }
}
