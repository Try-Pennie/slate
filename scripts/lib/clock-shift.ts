// How far to move the clock for a shifted test run (#2503).
//
// WHY THERE IS A SHIFTED RUN AT ALL. A test whose meaning is the RELATIONSHIP
// between a fixture and the present pins one end and reads the other, so it
// passes on the day it merges and goes red on some later day with nobody having
// touched the code (L130). That is #2497 exactly: `scripts/test-booking-reminder.ts`
// pinned its clock to a constant while `dayWord` read the real one, the fixture
// meant "tomorrow" when it merged on 2026-09-16 and "today" from midnight on the
// 17th, CI went red with no commit behind it, main's deploy was skipped, and a
// monitoring floor sat merged and not live for a day.
//
// Nothing ran the suite at any date but today, so the first thing to notice was
// main going red after a merge. Moving the clock forward is what turns that into
// a finding on a morning of our choosing instead.
//
// WHY A FIXED OFFSET rather than a frozen instant. Freezing the clock stops
// elapsed time, which breaks every timeout, every duration measurement and the
// runner's own progress accounting. An offset added to a real reading keeps time
// flowing at the usual rate and only moves where it starts, so a suite behaves
// exactly as it would on that future day.
//
// WHY MONTHS ARE RESOLVED ONCE, HERE. A calendar month is not a fixed number of
// milliseconds, so "three months ahead" can only be turned into an offset against
// a specific instant. That happens once at hook time and the OFFSET is what the
// process carries, which is what keeps the reading monotonic: recomputing the
// calendar arithmetic on every `Date.now()` would make the clock jump around a
// month boundary and could hand a caller a reading earlier than its predecessor.
//
// It is deliberately dependency free (no Luxon), because the hook that uses it
// loads before anything else in the process and must not drag the app's module
// graph in ahead of the code under test.

export interface ClockShift {
  /** The offset in milliseconds, added to every real reading. Never zero. */
  ms: number;
  /** The spec exactly as written, so a message can name what was asked for. */
  spec: string;
  /** The instant the shifted clock starts at, for reporting. */
  targetMs: number;
}

/**
 * Why a spec was refused. Each one is separate because they send a reader to do
 * different things: a typo is fixed in the workflow, a zero shift means the run
 * would have measured nothing, and an absurd one is almost always a missing unit
 * (L11).
 */
export type ClockShiftRefusal = "unreadable" | "no-movement" | "out-of-range";

export type ClockShiftResult =
  | { ok: true; shift: ClockShift }
  | { ok: false; refusal: ClockShiftRefusal; detail: string };

/** A century either way. Past this a spec is a mistake, not an intention. */
const MAX_SHIFT_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** `+13mo`, `3mo`, `-1d`, `6h`, `2w`, `1y`. The sign is optional and defaults to forward. */
const SPEC = /^([+-]?)(\d+)(h|d|w|mo|y)$/;

/**
 * Calendar arithmetic for the two units that have no fixed length, done through
 * the platform's own Date so a month roll, a leap day and a year roll are handled
 * the way every consumer of the shifted clock will handle them.
 *
 * The day is CLAMPED the way `setMonth` clamps it, which is worth knowing rather
 * than worth fixing: 31 January shifted by one month lands on 3 March, not on 28
 * February. A run is looking for tests that break at SOME other date, so landing
 * a couple of days either side of the nominal one costs nothing.
 */
function addCalendar(fromMs: number, amount: number, unit: "mo" | "y"): number {
  const at = new Date(fromMs);
  if (unit === "mo") at.setMonth(at.getMonth() + amount);
  else at.setFullYear(at.getFullYear() + amount);
  return at.getTime();
}

/**
 * Turn a spec into an offset against `fromMs`, or say why it cannot be one.
 *
 * It REFUSES rather than falling back to no shift, because a shift that silently
 * did not apply produces a run identical to an unshifted one, and that reads as a
 * clean result over exactly the defect the run exists to find (L98).
 */
export function parseClockShift(spec: string, fromMs: number): ClockShiftResult {
  const trimmed = spec.trim();
  const m = SPEC.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      refusal: "unreadable",
      detail:
        `"${spec}" is not a clock shift. Write a whole number and a unit, ` +
        `one of h, d, w, mo or y, optionally signed: +1d, 3mo, 13mo, -2w.`,
    };
  }
  const sign = m[1] === "-" ? -1 : 1;
  const amount = Number(m[2]) * sign;
  const unit = m[3] as string;

  const targetMs =
    unit === "mo" || unit === "y"
      ? addCalendar(fromMs, amount, unit)
      : fromMs + amount * (UNIT_MS[unit] as number);
  const ms = targetMs - fromMs;

  if (ms === 0) {
    return {
      ok: false,
      refusal: "no-movement",
      detail:
        `"${spec}" moves the clock nowhere, so the run would be an ordinary one ` +
        `wearing a shifted run's name.`,
    };
  }
  if (Math.abs(ms) > MAX_SHIFT_MS) {
    return {
      ok: false,
      refusal: "out-of-range",
      detail: `"${spec}" is further than a century from now, which is a missing unit far more often than an intention.`,
    };
  }
  return { ok: true, shift: { ms, spec: trimmed, targetMs } };
}

/** A one line description for a log, naming both the spec and where it lands. */
export function describeClockShift(shift: ClockShift): string {
  return `${shift.spec} (${new Date(shift.targetMs).toISOString().slice(0, 10)})`;
}
