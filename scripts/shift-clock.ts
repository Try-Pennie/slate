// Run a process with its clock moved to another day (#2503).
//
// Loaded with `--import ./scripts/shift-clock.ts` before anything else, so every
// module in the process sees the shifted clock from its first line. `run-tests.ts`
// adds it to each suite's argv when `SLATE_CLOCK_SHIFT` is set, which is what
// `.github/workflows/clock-shift.yml` uses to ask the suite what it will do on a
// day that has not happened yet.
//
// WHAT IT PATCHES, and why that is enough for this repo. Everything that reads the
// present here goes through `Date`: `Date.now()`, `new Date()` with no argument,
// and Luxon's `DateTime.now()` / `DateTime.local()`, whose `Settings.now` default
// is `() => Date.now()` and resolves the global at call time. Replacing the global
// `Date` with a subclass therefore moves all of them at once.
//
// WHAT IT DOES NOT MOVE, said here so a green shifted run is never read as more
// than it is (L400): `performance.now()` and `process.hrtime()` are monotonic
// clocks with no calendar meaning and are deliberately left alone, so timeouts and
// duration measurements behave normally; and anything that asks the operating
// system for the date through a child process (`date`, `git log`) is outside a
// single process's globals. The class the run exists to find is a JS date fixture
// judged against a JS reading of now, and that is what moves.
//
// A NODE child process IS moved (#3361). The runner also hands the hook to every
// node process a suite starts, through NODE_OPTIONS, because a suite that computes
// a moment on its own clock and passes it to a child is only tested at the shifted
// date if the child reads the same clock. Without that, the burst driver's child
// waited for a moment a day away on the real clock and the run blamed the suite.
// So a suite process can be handed the hook twice (on its argv and in NODE_OPTIONS),
// and the second evaluation must not shift it again: see the guard below.
//
// IT REFUSES RATHER THAN RUNNING UNSHIFTED. A bad spec throws on load, so the
// suite never starts. A run whose shift quietly did not apply is identical to an
// ordinary run, and a clean result then means nothing at all (L98), which is the
// failure mode this whole mechanism exists to avoid rather than reproduce.
import { parseClockShift, describeClockShift, type ClockShift } from "./lib/clock-shift.ts";

/** The name every caller uses. One spelling, so a typo is an unset variable, not a silent no-op. */
export const CLOCK_SHIFT_ENV = "SLATE_CLOCK_SHIFT";

/**
 * What a shifted process exposes about itself, on `globalThis`.
 *
 * The REAL Date is kept here deliberately: a control that wants to prove the clock
 * actually moved needs an unshifted reading to compare against, and once the global
 * is replaced there is no other way to get one. It is the only thing that can tell
 * "the shift applied" from "the shift was never asked for" from inside the process,
 * and those two look identical in every other respect.
 */
export interface ShiftedClockMarker {
  shift: ClockShift;
  realDate: DateConstructor;
}

declare global {
  var __slateShiftedClock: ShiftedClockMarker | undefined;
}

const spec = process.env[CLOCK_SHIFT_ENV]?.trim() ?? "";

// Already shifted means the hook was loaded twice under two spellings of its path
// (a relative argv specifier and the runner's file URL resolve to one module only
// while no symlink sits between them). Applying it again would put the process
// twice the offset ahead, which reads as a date dependent suite rather than a hook
// fault, so the first application stands.
if (spec !== "" && globalThis.__slateShiftedClock === undefined) {
  const RealDate = Date;
  const realNow = () => RealDate.now();
  const parsed = parseClockShift(spec, realNow());
  if (!parsed.ok) {
    throw new Error(
      `${CLOCK_SHIFT_ENV} was refused (${parsed.refusal}): ${parsed.detail}`,
    );
  }
  const { shift } = parsed;

  class ShiftedDate extends RealDate {
    // The no argument constructor is the only one that reads the present; every
    // other form is a caller supplied instant and must pass through untouched, or
    // a fixture built from a literal would move too and the pair would still agree.
    constructor(...args: ConstructorParameters<DateConstructor>) {
      if (args.length === 0) super(realNow() + shift.ms);
      else super(...(args as [number]));
    }
    static override now(): number {
      return realNow() + shift.ms;
    }
  }

  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  globalThis.__slateShiftedClock = { shift, realDate: RealDate };

  // One line on stderr, not stdout: the runner captures a suite's output and prints
  // it only on failure, and a green suite that printed a banner would be indistinguishable
  // from a noisy one. It is here so a single suite run by hand says what clock it is on.
  if (process.env.SLATE_CLOCK_SHIFT_QUIET !== "1") {
    process.stderr.write(`clock shifted ${describeClockShift(shift)}\n`);
  }
}
