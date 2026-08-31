/**
 * Pure half of `pnpm verify:ooo-protection` (#1478).
 *
 * The question is whether an approved time off is really blocking the agent, and
 * the only answer worth having comes from Google. `ooo_requests.side_effects`
 * and `busy_blocks` are written by the very code under test, so reading them
 * would be checking a system against records it wrote itself (L58). #1464 is the
 * proof: the request recorded the busy block as "ok (slate fallback)" for weeks
 * after the row had been deleted, and both Slack messages read as healthy.
 *
 * Two readings, and BOTH are required:
 *
 *  - the EVENT itself, fetched by the id Slate recorded, with its start and end
 *    checked against the request's window;
 *  - Google's own free/busy over that window.
 *
 * Free/busy alone cannot do it. Busy periods MERGE, so a neighbouring meeting
 * makes an oversized, mistimed or entirely absent time off event read as a
 * perfectly occupied window. The event read is what tells those apart.
 *
 * Nothing here talks to Google or the database, so every decision the command
 * makes is driven node natively by scripts/test-ooo-protection-live-check.ts.
 */
import { parseStampMs } from "../../src/lib/date/stamp.ts";
import { busyIntervalsFromFreeBusy } from "../../src/lib/booking/core.ts";
// The monitor's OWN exclusion predicate (#1485), imported rather than restated,
// so this command and the page it complements cannot drift about which requests
// Slate ever acted on (L41, L263).
import { slateActedOn } from "../../src/lib/monitor/ooo-protection.ts";
import { DateTime } from "luxon";

/** One approved request, as the command reads it out of `ooo_requests`. */
export interface ApprovedRequestRow {
  id: string;
  /** Read, not filtered on, so a named request can be refused by its real status. */
  status: string;
  userId: string;
  agentEmail: string | null;
  agentName: string | null;
  startsAt: string;
  endsAt: string;
  /** The zone the agent submitted in, used to read an all day event's dates. */
  displayTzId: string;
  agentEventId: string | null;
  busyBlockEffect: string | null;
  agentEventEffect: string | null;
}

/** Why a run found nothing it could check. Never a pass (L98). */
export type SelectionRefusal =
  | "no-approved-future-requests"
  | "only-unhandled-requests"
  | "request-not-found"
  | "request-not-approved"
  | "request-window-passed"
  | "request-unhandled";

export type Selection =
  | { ok: true; requests: ApprovedRequestRow[]; skippedUnhandled: number }
  | { ok: false; code: SelectionRefusal; why: string };

export interface SelectOptions {
  nowMs: number;
  /** A single request id to check, or null to sweep. */
  requestedId: string | null;
  /** Include the imported requests Slate never acted on (#1485 / #1486). */
  includeUnhandled: boolean;
}

/** The monitor's shape, filled from a row, so its predicate can judge it. */
function asMonitorRow(r: ApprovedRequestRow) {
  return {
    id: r.id,
    userId: r.userId,
    agentName: r.agentName,
    agentEmail: r.agentEmail,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    displayTzId: r.displayTzId,
    displayTzLabel: null,
    agentEventId: r.agentEventId,
    busyBlockEffect: r.busyBlockEffect,
    agentEventEffect: r.agentEventEffect,
  };
}

function endsAfter(r: ApprovedRequestRow, nowMs: number): boolean {
  const end = parseStampMs(r.endsAt);
  // An unreadable end is kept, deliberately: dropping it here would send a row
  // nothing can read straight past the check that exists to report it.
  return end === null || end > nowMs;
}

/**
 * What this run will check, or the reason there is nothing to check.
 *
 * Every way of finding nothing gets its OWN refusal, because they call for
 * different things from the reader: an empty sweep may mean the query is wrong,
 * a sweep of nothing but imported rows means the exclusion swallowed the lot, and
 * a named request that is not approved means the id was mistyped or decided
 * since. One message answering for another is exactly how a blind check reads as
 * a healthy one (L11).
 */
export function selectRequests(rows: ApprovedRequestRow[], opts: SelectOptions): Selection {
  if (opts.requestedId !== null) {
    const row = rows.find((r) => r.id === opts.requestedId);
    if (!row) {
      return {
        ok: false,
        code: "request-not-found",
        why: `no ooo_requests row has id ${opts.requestedId}`,
      };
    }
    if (row.status !== "approved") {
      return {
        ok: false,
        code: "request-not-approved",
        why: `request ${row.id} is ${row.status}, so nothing is expected to be blocking its window`,
      };
    }
    if (!endsAfter(row, opts.nowMs)) {
      return {
        ok: false,
        code: "request-window-passed",
        why: `request ${row.id} ended at ${row.endsAt}, so nothing can be booked into it now`,
      };
    }
    if (!opts.includeUnhandled && !slateActedOn(asMonitorRow(row))) {
      return {
        ok: false,
        code: "request-unhandled",
        why:
          `request ${row.id} carries no calendar event id and no recorded outcome, so Slate ` +
          `never ran a step for it (#1485). Set OOO_VERIFY_INCLUDE_UNHANDLED=1 to check it anyway`,
      };
    }
    return { ok: true, requests: [row], skippedUnhandled: 0 };
  }

  const live = rows.filter((r) => r.status === "approved" && endsAfter(r, opts.nowMs));
  if (live.length === 0) {
    return {
      ok: false,
      code: "no-approved-future-requests",
      why:
        "no approved time off has a window still ahead of us, so this run checked nothing. " +
        "That is not the same as everything being protected",
    };
  }
  if (opts.includeUnhandled) return { ok: true, requests: live, skippedUnhandled: 0 };

  const handled = live.filter((r) => slateActedOn(asMonitorRow(r)));
  const skippedUnhandled = live.length - handled.length;
  if (handled.length === 0) {
    return {
      ok: false,
      code: "only-unhandled-requests",
      why:
        `all ${live.length} approved future request(s) were imported from the old tool with no ` +
        "recorded outcome (#1485), so none of them can have lost a cover Slate wrote. Their real " +
        "calendars are the subject of #1486 and of scripts/verify-imported-timeoff-cover.ts. " +
        "Set OOO_VERIFY_INCLUDE_UNHANDLED=1 to check them here instead",
    };
  }
  return { ok: true, requests: handled, skippedUnhandled };
}

/** One end of a Google event, in either of the two shapes Google returns. */
export interface GoogleTimePoint {
  dateTime?: string;
  /** All day events carry a bare date. Google's end date is EXCLUSIVE. */
  date?: string;
  timeZone?: string;
}

/** The fields of a Google event this check reads. */
export interface GoogleEventTimes {
  status?: string;
  transparency?: string;
  start?: GoogleTimePoint;
  end?: GoogleTimePoint;
}

/** One busy period exactly as Google reported it, either bound possibly garbage. */
export interface BusyPeriod {
  start: string;
  end: string;
}

/**
 * What Google said about the recorded event.
 *
 * `not-recorded` and `gone` are kept apart all the way to the message: one means
 * Slate never held an event id for this request, the other means it held one and
 * Google no longer has that event. They are different failures with different
 * repairs, and collapsing them would lose the #1464 signature entirely.
 */
export type EventReading =
  | { state: "not-recorded" }
  | { state: "gone" }
  | { state: "found"; event: GoogleEventTimes };

/**
 * One request's live reading, or the reason there is not one.
 *
 * A failed calendar read is three things here, not two, matching the vocabulary
 * the sync health path already uses (#1396): `refused` is a credential or
 * membership repair, `not-provisioned` is an account that has never been given
 * Calendar at all and can only be fixed by a Workspace admin, and `unreadable`
 * is a transient failure worth re-running. Collapsing the middle one into either
 * neighbour hands the reader advice that cannot work.
 */
export type CalendarReading =
  | { kind: "read"; event: EventReading; busy: BusyPeriod[] }
  | { kind: "no-agent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "not-provisioned"; detail: string }
  | { kind: "refused"; detail: string };

/**
 * Every outcome this check can reach. Declared so the offline suite can insist
 * each one is actually PRODUCED by a case rather than merely listed (L151).
 */
export const VERDICT_CODES = [
  "verified",
  "event-window-wider",
  "event-window-uncovered",
  "event-window-unreadable",
  "event-cancelled",
  "event-marked-free",
  "event-matches-but-window-free",
  "event-never-recorded-window-free",
  "event-never-recorded-window-busy",
  "event-gone-window-free",
  "event-gone-window-busy",
  "busy-unreadable",
  "request-window-unreadable",
  "no-agent",
  "calendar-unreadable",
  "calendar-not-provisioned",
  "calendar-refused",
] as const;

export type VerdictCode = (typeof VERDICT_CODES)[number];

export interface Verdict {
  requestId: string;
  code: VerdictCode;
  /** True for `verified` and nothing else. A run proves protection or it does not. */
  ok: boolean;
  detail: string;
}

export interface JudgeOptions {
  /**
   * How far an event bound may sit from the recorded one and still count as the
   * same window. A minute: the request form works in minutes, so nothing a person
   * can do moves an event by less than one, and anything under it is how two
   * systems render the same instant rather than a real difference.
   */
  toleranceMs: number;
  nowMs: number;
}

interface Span {
  start: number;
  end: number;
}

/** Merge overlapping or abutting spans, so two back to back busy periods cover
 *  the window between them rather than reading as two separate gaps. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

function covers(spans: Span[], from: number, to: number): boolean {
  if (from >= to) return true;
  return merge(spans).some((s) => s.start <= from && s.end >= to);
}

/**
 * One end of an event as epoch ms, or null when it cannot be read.
 *
 * A bare date is an all day event, read in the event's own zone when Google gave
 * one and otherwise in the zone the agent submitted the request in. Null rather
 * than NaN, because NaN compares false against every bound and would land on the
 * permissive side of every comparison below (L50).
 */
function pointMs(point: GoogleTimePoint | undefined, fallbackZone: string): number | null {
  if (!point) return null;
  if (point.dateTime) return parseStampMs(point.dateTime);
  if (point.date) {
    const zone = point.timeZone || fallbackZone;
    const dt = DateTime.fromISO(point.date, { zone });
    return dt.isValid ? dt.toMillis() : null;
  }
  return null;
}

const minutes = (ms: number): string => {
  const n = Math.round(ms / 60_000);
  return `${n} minute${n === 1 ? "" : "s"}`;
};

/**
 * The verdict for one request, from Google's own answer.
 *
 * The event window is compared against the WHOLE recorded window, because that
 * comparison is what says the calendar and the record agree. The free/busy
 * answer is judged over the part of the window still ahead of us, because that
 * is the part a lead can still be booked into, and reporting hours that have
 * already passed would name something nobody can act on.
 *
 * Only `verified` passes. Every other outcome carries its own sentence saying
 * what was measured, so a run that could not check something never reads like a
 * run that checked it and found it fine.
 */
export function judgeRequest(
  request: ApprovedRequestRow,
  reading: CalendarReading,
  opts: JudgeOptions,
): Verdict {
  const at = (code: VerdictCode, detail: string): Verdict => ({
    requestId: request.id,
    code,
    ok: code === "verified",
    detail,
  });

  if (reading.kind === "no-agent") {
    return at(
      "no-agent",
      `the agent on this request (user ${request.userId}) could not be read, so there is no ` +
        "calendar to ask. Nothing here says whether the window is protected",
    );
  }
  if (reading.kind === "unreadable") {
    return at(
      "calendar-unreadable",
      "the live Google read failed for a reason that usually clears on its own, so this window " +
        `was never checked: ${reading.detail}. Run it again`,
    );
  }
  if (reading.kind === "not-provisioned") {
    return at(
      "calendar-not-provisioned",
      "this agent has never been given Google Calendar, so there is no calendar for the time off " +
        `to sit on and nothing here could be checked: ${reading.detail}. Retrying can never fix ` +
        "it, and nothing is wrong with the credentials: a Workspace admin has to give them Calendar",
    );
  }
  if (reading.kind === "refused") {
    return at(
      "calendar-refused",
      "Google refused this agent's calendar, so this window was never checked: " +
        `${reading.detail}. That is a credential or membership repair: re-auth, or take them out ` +
        "of the pool",
    );
  }

  const start = parseStampMs(request.startsAt);
  const end = parseStampMs(request.endsAt);
  if (start === null || end === null) {
    return at(
      "request-window-unreadable",
      `the stored window (${request.startsAt} to ${request.endsAt}) cannot be read, so nothing ` +
        "could be compared against it",
    );
  }

  const busySpans = busyIntervalsFromFreeBusy(reading.busy);
  if (busySpans === null) {
    return at(
      "busy-unreadable",
      "Google returned a busy period with a bound that cannot be read, so the whole free/busy " +
        "answer is refused. Keeping the readable part would make the unreadable one look like free time",
    );
  }
  const from = Math.min(Math.max(start, opts.nowMs), end);
  const windowBusy = covers(busySpans, from, end);
  const busyPhrase = windowBusy
    ? "Google reports the window as fully occupied"
    : "Google reports part of the window as free";

  if (reading.event.state === "not-recorded") {
    return windowBusy
      ? at(
          "event-never-recorded-window-busy",
          "Slate holds no calendar event id for this request, and " +
            `${busyPhrase} anyway. Busy periods merge, so that can be a neighbouring meeting: ` +
            "nothing here shows the time off is what is blocking the window",
        )
      : at(
          "event-never-recorded-window-free",
          "Slate holds no calendar event id for this request and " +
            `${busyPhrase}. A lead can be booked into this time off`,
        );
  }
  if (reading.event.state === "gone") {
    return windowBusy
      ? at(
          "event-gone-window-busy",
          `the event Slate recorded (${request.agentEventId}) is no longer on the agent's ` +
            `calendar, and ${busyPhrase} anyway. Busy periods merge, so that can be a ` +
            "neighbouring meeting rather than this time off",
        )
      : at(
          "event-gone-window-free",
          `the event Slate recorded (${request.agentEventId}) is no longer on the agent's ` +
            `calendar and ${busyPhrase}. A lead can be booked into this time off`,
        );
  }

  const ev = reading.event.event;
  if (ev.status === "cancelled") {
    return at(
      "event-cancelled",
      `the event Slate recorded (${request.agentEventId}) is cancelled, so it blocks nothing ` +
        `however well its times read. ${busyPhrase}`,
    );
  }
  if (ev.transparency === "transparent") {
    return at(
      "event-marked-free",
      `the event Slate recorded (${request.agentEventId}) is marked as free rather than busy, ` +
        `so it does not block the agent. ${busyPhrase}`,
    );
  }

  const evStart = pointMs(ev.start, request.displayTzId);
  const evEnd = pointMs(ev.end, request.displayTzId);
  if (evStart === null || evEnd === null) {
    return at(
      "event-window-unreadable",
      `Google returned the event but its ${evStart === null ? "start" : "end"} cannot be read, ` +
        "so its window could not be compared with the request",
    );
  }

  const startOff = evStart - start;
  const endOff = evEnd - end;
  const matched = Math.abs(startOff) <= opts.toleranceMs && Math.abs(endOff) <= opts.toleranceMs;
  if (!matched) {
    const coversWindow = evStart <= start + opts.toleranceMs && evEnd >= end - opts.toleranceMs;
    if (coversWindow) {
      return at(
        "event-window-wider",
        `the event covers the approved window but its own times differ from it: it starts ` +
          `${minutes(Math.abs(startOff))} ${startOff < 0 ? "before" : "after"} the request and ends ` +
          `${minutes(Math.abs(endOff))} ${endOff > 0 ? "after" : "before"} it. The calendar and the ` +
          "record disagree about this time off",
      );
    }
    const openStart = Math.max(0, Math.min(evStart, end) - start);
    const openEnd = Math.max(0, end - Math.max(evEnd, start));
    return at(
      "event-window-uncovered",
      `the event does not cover the approved window: ${minutes(openStart)} at the start and ` +
        `${minutes(openEnd)} at the end are left open. A lead can be booked into the open part`,
    );
  }

  if (!windowBusy) {
    return at(
      "event-matches-but-window-free",
      "the event matches the approved window, yet Google's own free/busy still reports part of " +
        "that window as free, so the event is not blocking the calendar it sits on",
    );
  }
  return at(
    "verified",
    "the event on the agent's calendar matches the approved window, and Google's own free/busy " +
      "reports that window as fully occupied",
  );
}

export interface Summary {
  ok: boolean;
  verified: number;
  failed: number;
  lines: string[];
}

/**
 * Roll the verdicts up.
 *
 * An EMPTY list is not a pass. A run that judged nothing proved nothing, and the
 * whole reason this command exists is that "found nothing wrong" and "could not
 * look" render identically in a summary (L98).
 */
export function summarize(verdicts: Verdict[]): Summary {
  const verified = verdicts.filter((v) => v.ok).length;
  const failed = verdicts.length - verified;
  const lines = verdicts.map(
    (v) => `${v.ok ? "VERIFIED" : "FAILED  "} ${v.requestId}  ${v.code}: ${v.detail}`,
  );
  return { ok: verdicts.length > 0 && failed === 0, verified, failed, lines };
}
