// Repo invariant (#2503): the suite can be run at a date that has not happened yet,
// and a test that depends on today FAILS when it is.
//
// #2497 is what this is for. `scripts/test-booking-reminder.ts` pinned its clock to
// a constant while the copy builder read the real one, so the fixture meant
// "tomorrow" on the day it merged and "today" from midnight, CI went red with no
// commit behind it, and main's deploy was skipped with a monitoring floor merged and
// not live (L130: a fixture whose meaning is a relationship between a stored date and
// the clock must pin BOTH ends). Nothing ran the suite at any date but today, so the
// first thing to notice was main.
//
// Three things are held here, and the third is the one that matters:
//
//   1. the shift spec parser refuses everything it cannot turn into a real movement,
//      rather than falling back to no shift, because an unapplied shift produces a
//      run identical to an ordinary one and a clean result then means nothing (L98);
//   2. a process that WAS shifted can say so from the inside, and one that was asked
//      to shift and did not is a hard failure here rather than a quiet pass;
//   3. THE POSITIVE CONTROL. A date dependent test is planted in a temporary file,
//      run through the real runner twice, and required to pass unshifted and FAIL
//      shifted. Without it a hook that silently did nothing, an argv wiring typo, or
//      a runner that dropped the flag would all report this mechanism working for
//      ever while catching nothing (L1).
//
// The plant is written to the system temp directory, never into the repo, so a run
// leaves no file behind and a crashed run leaves nothing to clean up in git.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-clock-shift.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseClockShift, describeClockShift } from "./lib/clock-shift.ts";
import { CLOCK_SHIFT_ENV } from "./shift-clock.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;

// A fixed anchor, so the calendar arithmetic below is asserted against a date
// somebody chose rather than against whatever today happens to be. Pinning BOTH
// ends is the whole subject of this file, so its own fixtures may not read the
// clock either. 2026-01-31T12:00:00Z is picked for the month end clamp.
const ANCHOR = Date.UTC(2026, 0, 31, 12, 0, 0);

// --- 1. the parser ------------------------------------------------------------
{
  const day = parseClockShift("+1d", ANCHOR);
  assert(day.ok, "a signed day shift is read");
  if (day.ok) eq(day.shift.ms, DAY_MS, "and it is exactly one day forward");

  const unsigned = parseClockShift("3d", ANCHOR);
  assert(unsigned.ok, "an unsigned shift is read as forward");
  if (unsigned.ok) eq(unsigned.shift.ms, 3 * DAY_MS, "and carries the right distance");

  const back = parseClockShift("-2w", ANCHOR);
  assert(back.ok, "a negative shift is read");
  if (back.ok) eq(back.shift.ms, -14 * DAY_MS, "and moves backwards");

  // A calendar month is not a fixed number of milliseconds, which is the entire
  // reason it is resolved against an instant rather than multiplied out.
  const months = parseClockShift("+13mo", ANCHOR);
  assert(months.ok, "a month shift is read");
  if (months.ok) {
    assert(
      months.shift.ms !== 13 * 30 * DAY_MS,
      "and it is real calendar arithmetic rather than thirty day months",
    );
    // Thirteen months from any date crosses a year roll and both of the year's
    // clock changes, which is why the workflow uses it.
    assert(
      new Date(months.shift.targetMs).getUTCFullYear() ===
        new Date(ANCHOR).getUTCFullYear() + 1,
      "thirteen months ahead lands in the following year",
    );
  }

  // Every refusal, each with its own name, because they send a reader to do
  // different things: a typo is fixed in the workflow, a zero shift means the run
  // would have measured nothing (L11).
  const unreadable = parseClockShift("tomorrow", ANCHOR);
  assert(!unreadable.ok, "a spec that is not a shift is refused");
  if (!unreadable.ok) eq(unreadable.refusal, "unreadable", "and says it could not read it");

  const noUnit = parseClockShift("86400000", ANCHOR);
  assert(!noUnit.ok, "a bare number carries no unit and is refused");

  const zero = parseClockShift("+0d", ANCHOR);
  assert(!zero.ok, "a shift that moves nothing is refused");
  if (!zero.ok) eq(zero.refusal, "no-movement", "and says so in its own words");

  const absurd = parseClockShift("9999y", ANCHOR);
  assert(!absurd.ok, "a shift past a century is refused");
  if (!absurd.ok) eq(absurd.refusal, "out-of-range", "as out of range rather than unreadable");

  // No two refusals share a message, or one would answer for another (L11).
  const refusals = [unreadable, zero, absurd].filter((r) => !r.ok);
  eq(
    new Set(refusals.map((r) => (r.ok ? "" : r.detail))).size,
    refusals.length,
    "each refusal explains itself differently",
  );

  const described = parseClockShift("+1d", ANCHOR);
  if (described.ok) {
    assert(
      describeClockShift(described.shift).includes("2026-02-01"),
      `the description names the day it lands on (${describeClockShift(described.shift)})`,
    );
  }
}

// --- 2. a shifted process can say so from the inside --------------------------
// This suite is run BOTH ways: ordinarily by `pnpm test`, and again under the
// shifted workflow. In the shifted run it is the check that the shift reached the
// child at all, which nothing else can see: a suite that quietly ran on the real
// clock passes every other assertion in the repo.
{
  const asked = process.env[CLOCK_SHIFT_ENV]?.trim() ?? "";
  const marker = globalThis.__slateShiftedClock;

  if (asked === "") {
    eq(marker, undefined, "an ordinary run carries no shifted clock, so the hook is inert");
  } else {
    assert(marker !== undefined, `${CLOCK_SHIFT_ENV}=${asked} was asked for and the hook applied it`);
    if (marker) {
      // The real Date is kept by the hook precisely so this comparison is possible:
      // once the global is replaced there is no other unshifted reading to be had.
      const drift = Date.now() - marker.realDate.now() - marker.shift.ms;
      assert(
        Math.abs(drift) < 5000,
        `the clock really moved by ${describeClockShift(marker.shift)} (off by ${drift}ms)`,
      );
      assert(
        new Date().toISOString().slice(0, 10) !==
          new marker.realDate().toISOString().slice(0, 10),
        "and it is a different calendar day from the real one",
      );
    }
  }
}

// --- 3. the positive control --------------------------------------------------
// A test whose meaning is "this fixture is about now" is planted, and run through
// the real runner twice. It must pass on the real clock and FAIL on a shifted one.
// Both directions, or the check is satisfied by a runner hard wired to one answer
// (L1): passing only unshifted would be met by a shift that does nothing, and
// failing only shifted would be met by a plant that is simply broken.
{
  const dir = mkdtempSync(join(tmpdir(), "slate-clock-shift-"));
  try {
    const plant = join(dir, "planted-date-dependent.ts");
    // Deliberately the L130 shape: one end pinned (the anchor handed in), the other
    // end read from the clock. No date literal, so the plant means the same thing
    // whenever it is run and the guard never needs editing on a calendar.
    writeFileSync(
      plant,
      [
        "const anchor = Number(process.env.PLANTED_ANCHOR_MS);",
        "const drift = Math.abs(Date.now() - anchor);",
        "if (drift > 60_000) {",
        '  console.error("FAIL: the planted fixture is no longer about now, drift " + drift + "ms");',
        "  process.exit(1);",
        "}",
        'console.log("ok: the planted fixture is still about now");',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const runPlant = (shift: string | null) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--import",
          "./scripts/register-paths.mjs",
          "scripts/run-tests.ts",
          plant,
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PLANTED_ANCHOR_MS: String(
              (globalThis.__slateShiftedClock?.realDate ?? Date).now(),
            ),
            // Always written out, never inherited: this suite may itself be running
            // under a shift, and a control that quietly took the ambient one would
            // be measuring the run rather than the mechanism.
            [CLOCK_SHIFT_ENV]: shift ?? "",
            SLATE_CLOCK_SHIFT_QUIET: "1",
          },
        },
      );

    const plain = runPlant(null);
    eq(plain.status, 0, `the planted date dependent test passes on the real clock${detail(plain)}`);

    const shifted = runPlant("+1d");
    eq(
      shifted.status,
      1,
      `and FAILS when the suite is run a day ahead${detail(shifted)}`,
    );
    assert(
      /no longer about now/.test(`${shifted.stdout}${shifted.stderr}`),
      "failing for its own reason, not because the runner fell over",
    );
    assert(
      /clock \+1d/.test(`${shifted.stdout}${shifted.stderr}`),
      "and the run's summary names the clock it was on",
    );

    // A spec the parser refuses must stop the run rather than quietly running it on
    // the real clock, which is the one outcome that would read as a clean shifted run.
    const refused = runPlant("tomorrow");
    assert(
      refused.status !== 0,
      `an unreadable shift spec refuses the run${detail(refused)}`,
    );
    assert(
      /was refused/.test(`${refused.stdout}${refused.stderr}`),
      "and says the shift was refused rather than failing as an ordinary test",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function detail(r: { status: number | null; stdout: string; stderr: string }): string {
  return r.status === 0 || r.status === 1
    ? ""
    : ` (exit ${r.status}: ${`${r.stdout}${r.stderr}`.trim().slice(-400)})`;
}

finish();
