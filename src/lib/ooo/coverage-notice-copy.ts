// Relative value imports so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { parseStampMs } from "../date/stamp.ts";
import { formatWhenLine } from "./core.ts";

/**
 * What the manager's time off notice says about the customer appointments a
 * coverage sweep will move, and about the ones it moved (#1239).
 *
 * A manager could approve time off with one click and have no idea it was about
 * to move a dozen customer appointments. These builders are the only place those
 * sentences exist: pure, so every state (nothing to move, one, many, a count
 * that could not be read, an appointment starting within the hour) is asserted
 * and readable in `scripts/test-ooo-coverage-notice-copy.ts` rather than being
 * discovered in Slack. `preview:alerts` cannot show them because they are
 * notifications to one manager, not alert catalog keys.
 */

/**
 * How soon an appointment has to start before the approved notice NAMES it, so
 * whoever is reading can also phone that customer.
 *
 * This threshold affects what the notice SAYS and NEVER what moves. The rule for
 * what moves is `movesUnderCoverage` (`src/lib/booking/coverage-selection.ts`)
 * and it carries no lead time at all: everything still ahead moves. Two placement
 * rules that disagree is exactly what keeping this out of the selection avoids.
 */
export const COVERAGE_SHORT_NOTICE_MS = 2 * 60 * 60 * 1000;

/** One appointment a sweep queued, as the manager reads it. */
export interface CoverageMove {
  startsAtIso: string;
  endsAtIso: string;
  /** Null when the booking holds no attendee name. */
  attendeeName: string | null;
}

/**
 * What the coverage step of an approval actually did.
 *
 * `queued: 0` is a measured "nothing was in the window", which reads differently
 * from `failed` (retryable) and from `already` (an earlier run did the work and
 * this one holds no number of its own) (L11).
 */
export type CoverageSweepState =
  | { kind: "queued"; queued: number; moves: CoverageMove[] }
  | { kind: "failed"; reason: string }
  | { kind: "already" };

export interface CoverageNoticeContext {
  nowIso: string;
  tzId: string;
  tzLabel: string;
}

/** How many appointments are named before the list is trimmed. */
const MAX_NAMED = 3;

const hours = COVERAGE_SHORT_NOTICE_MS / (60 * 60 * 1000);

const appointments = (n: number): string =>
  `${n} upcoming ${n === 1 ? "appointment" : "appointments"}`;

/**
 * The line on the PENDING notice: how many appointments approving this would
 * move.
 *
 * `count` is `null` when the count could not be read, and that state has its own
 * sentence. It must never fall through to the zero branch: the zero branch is
 * silence, and a manager reads silence as "nothing will move". An empty result
 * here is indistinguishable from a healthy one, which is the case that has to
 * fail loud rather than default (AGENTS.md, "Ask what the EMPTY result means
 * downstream").
 *
 * Worded as a count as of now, deliberately. The agent stays bookable until the
 * approval lands, so the real number only ever drifts upward while the request
 * waits, and a number presented as final would be wrong in one direction with no
 * hint of it.
 */
export function pendingCoverageLine(count: number | null): string | null {
  if (count === null) {
    return (
      `Slate could not read how many upcoming appointments fall in this time off. ` +
      `That is not the same as none, so check their coverage panel before approving.`
    );
  }
  if (count <= 0) return null;
  return (
    `${appointments(count)} ${count === 1 ? "falls" : "fall"} in this time off and will ` +
    `move to another advisor when you approve. That is the count right now, and it can ` +
    `grow while the request waits.`
  );
}

/** One appointment, as something a person could act on: when it is, and who with. */
function namedMove(m: CoverageMove, ctx: CoverageNoticeContext): string {
  const who = m.attendeeName?.trim() ? m.attendeeName.trim() : "a customer";
  return `${formatWhenLine(m.startsAtIso, m.endsAtIso, ctx.tzId, ctx.tzLabel)} with ${who}`;
}

/**
 * Is this one starting soon enough to be worth a phone call?
 *
 * An unreadable start answers YES. `parseStampMs` returns null rather than a NaN
 * that would quietly compare false (the `parse-ok` convention), and the fail safe
 * side here is naming it: the cost of one extra line is a person glancing at an
 * appointment that was not urgent, and the cost of dropping it is a customer
 * nobody called.
 */
function isShortNotice(m: CoverageMove, nowIso: string): boolean {
  const starts = parseStampMs(m.startsAtIso);
  const now = parseStampMs(nowIso);
  if (starts === null || now === null) return true;
  return starts - now < COVERAGE_SHORT_NOTICE_MS;
}

/**
 * The line on the APPROVED edit of the manager's message: what the sweep did,
 * and which of those appointments start soon enough to also warrant a call.
 */
export function approvedCoverageLine(
  state: CoverageSweepState,
  ctx: CoverageNoticeContext,
): string | null {
  if (state.kind === "failed") {
    return (
      `Their upcoming appointments could not be queued to move (${state.reason}). ` +
      `They are still on the agent who is away. Retry the calendar updates on the ` +
      `request, or move them by hand from that agent's coverage panel.`
    );
  }
  if (state.kind === "already") {
    return `Their upcoming appointments were already queued to move on an earlier run.`;
  }
  if (state.queued <= 0) {
    return `Nothing needed moving: no upcoming appointments fall in this time off.`;
  }

  const head = `${appointments(state.queued)} ${state.queued === 1 ? "was" : "were"} queued to move to another advisor.`;
  const soon = state.moves
    .filter((m) => isShortNotice(m, ctx.nowIso))
    .sort((a, b) => a.startsAtIso.localeCompare(b.startsAtIso));
  if (soon.length === 0) return head;

  const named = soon.slice(0, MAX_NAMED).map((m) => namedMove(m, ctx)).join("; ");
  const rest = soon.length > MAX_NAMED ? ` and ${soon.length - MAX_NAMED} more` : "";
  return (
    `${head}\nStarting within ${hours} hours: ${named}${rest}. ` +
    `Worth calling ${soon.length === 1 ? "that customer" : "those customers"} too, ` +
    `since the new advisor may reach them with very little notice.`
  );
}

/**
 * The line on a CANCELLED request: what happens to the appointments the sweep
 * already moved.
 *
 * They stay with the covering advisor. That is a decision (#1219 decision 4): the
 * customer has been told twice by then, and the covering advisor is holding the
 * slot under their own cap. Saying it here makes it something the reader was
 * told rather than something they discover.
 */
export function cancelledCoverageLine(wasApproved: boolean): string | null {
  if (!wasApproved) return null;
  return (
    `Any appointments that already moved to another advisor stay with that advisor. ` +
    `Cancelling this time off does not move them back.`
  );
}
