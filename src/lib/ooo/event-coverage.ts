// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { parseStampMs } from "../date/stamp.ts";

/**
 * Does an approved time off's calendar event still cover the approved window? (#3360)
 *
 * Since #3360 the approved window is HELD by a Slate written busy block the calendar
 * sync never rewrites (`heldWindowBlock` in orchestration.ts), so an edit in Google can
 * no longer open approved hours to bookings. What an edit can still do is make the
 * record and the calendar disagree, and only a person can say which one is true: on
 * 2026-10-06 the edit was the true one (the agent was working that morning) and the
 * request was stale. So the disagreement is reported, never repaired, and this is the
 * one rule that decides it.
 *
 * Read by both the calendar sync, which pages the moment it sees an edited event, and
 * the monitor lane, which re-measures every approved future request and is the only
 * place the all-clear is decided. One judge, so the page and its ending cannot mean
 * different things (L107). The tolerance is `verify:ooo-protection`'s default, so the
 * command and the page agree about which pairs match.
 */

/** A minute of slack at each end, matching `verify:ooo-protection`'s default. */
export const OOO_EVENT_TOLERANCE_MS = 60_000;

/** A half open interval in epoch ms. */
export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * The parts of `window` no span in `cover` reaches. A gap no longer than the
 * tolerance is rounding, not a finding, and is dropped; anything longer is reported
 * whole, so the boundary is never silently widened.
 */
export function uncoveredSpans(
  window: Span,
  cover: Span[],
  toleranceMs: number = OOO_EVENT_TOLERANCE_MS,
): Span[] {
  const merged: Span[] = [];
  for (const c of [...cover].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && c.startMs <= last.endMs) last.endMs = Math.max(last.endMs, c.endMs);
    else merged.push({ ...c });
  }
  const open: Span[] = [];
  let cursor = window.startMs;
  for (const c of merged) {
    if (c.endMs <= cursor) continue;
    if (c.startMs >= window.endMs) break;
    if (c.startMs > cursor) open.push({ startMs: cursor, endMs: c.startMs });
    cursor = Math.max(cursor, c.endMs);
    if (cursor >= window.endMs) break;
  }
  if (cursor < window.endMs) open.push({ startMs: cursor, endMs: window.endMs });
  return open.filter((s) => s.endMs - s.startMs > toleranceMs);
}

/**
 * The verdict for one approved request.
 *
 *  - `covered`: the event covers what is left of the approved window (wider is fine).
 *  - `uncovered`: the event blocks only part of it; `spans` are the open parts.
 *  - `not-blocking`: the calendar shows no busy event for it at all, because it was
 *    deleted, cancelled, declined or marked free. Kept apart from `uncovered`
 *    because it reads differently to the person fixing it.
 *  - `passed`: the window is over, so there is nothing left to reconcile.
 *  - `unreadable`: a stamp could not be read, so nothing was compared. Never a
 *    finding and never coverage (L50).
 */
export type EventCoverage =
  | { kind: "covered" }
  | { kind: "uncovered"; spans: Span[] }
  | { kind: "not-blocking" }
  | { kind: "passed" }
  | { kind: "unreadable" };

export function judgeEventCoverage(input: {
  startsAt: string;
  endsAt: string;
  nowMs: number;
  /**
   * What the calendar blocks for this request's event, as stored instants. `null`
   * or empty means it blocks nothing, which is never read as covered.
   */
  cover: { startsAt: string; endsAt: string }[] | null;
}): EventCoverage {
  const start = parseStampMs(input.startsAt);
  const end = parseStampMs(input.endsAt);
  if (start === null || end === null) return { kind: "unreadable" };
  if (end <= input.nowMs) return { kind: "passed" };
  const cover: Span[] = [];
  for (const c of input.cover ?? []) {
    const s = parseStampMs(c.startsAt);
    const e = parseStampMs(c.endsAt);
    if (s === null || e === null) return { kind: "unreadable" };
    if (e > s) cover.push({ startMs: s, endMs: e });
  }
  if (cover.length === 0) return { kind: "not-blocking" };
  // Only what is still ahead: hours already gone cannot be booked into.
  const open = uncoveredSpans({ startMs: Math.max(start, input.nowMs), endMs: end }, cover);
  return open.length === 0 ? { kind: "covered" } : { kind: "uncovered", spans: open };
}
