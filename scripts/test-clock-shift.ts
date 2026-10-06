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
import { parseClockShift, describeClockShift, nodeOptionsWithHook } from "./lib/clock-shift.ts";
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

// --- 4. a node process the suite STARTS is on the shifted clock too (#3361) ---
// A suite that computes a moment from its own (shifted) clock and hands it to a
// child `node` process is only tested at the shifted date if the child reads the
// same clock. Before #3361 it did not: the child ran on the real clock, waited for
// a moment a day away, and the run blamed the suite for depending on the date
// (scripts/test-loadtest-burst-driver.ts, 29 checks, every shift). So a suite of
// exactly that shape is planted and run through the real runner, both ways.
//
// The plant lives in a directory whose name carries a space and a curly apostrophe,
// the two characters the real checkout path holds and NODE_OPTIONS splits or chokes
// on, and the child is started with that directory as its cwd, so a hook named by a
// path relative to the repo could not reach it.
{
  const dir = mkdtempSync(join(tmpdir(), "slate clock shift’s child "));
  try {
    const plant = join(dir, "planted-child-clock.ts");
    writeFileSync(
      plant,
      [
        'import { execFileSync } from "node:child_process";',
        "const anchor = Number(process.env.PLANTED_ANCHOR_MS);",
        "const expected = Number(process.env.PLANTED_EXPECT_SHIFT_MS);",
        "const own = Date.now() - anchor - expected;",
        "const childNow = Number(",
        "  execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], {",
        "    cwd: " + JSON.stringify(dir) + ",",
        "    encoding: 'utf8',",
        "  }),",
        ");",
        "const child = childNow - anchor - Number(process.env.PLANTED_EXPECT_CHILD_SHIFT_MS);",
        "const options = process.env.NODE_OPTIONS ?? '';",
        "const wanted = process.env.PLANTED_EXPECT_OPTIONS ?? '';",
        "console.log('own offset error ' + own + 'ms, child offset error ' + child + 'ms, NODE_OPTIONS=' + JSON.stringify(options));",
        "if (!Number.isFinite(childNow)) { console.error('FAIL: the child printed no clock'); process.exit(1); }",
        // An unreadable anchor or expectation is NaN, which every comparison below
        // would read as within tolerance (L50), so it refuses here instead.
        "if (!Number.isFinite(own) || !Number.isFinite(child)) { console.error('FAIL: the plant could not read its anchor or expectations'); process.exit(1); }",
        "if (Math.abs(own) > 60_000) { console.error('FAIL: the suite itself is off its expected clock'); process.exit(1); }",
        "if (Math.abs(child) > 60_000) { console.error('FAIL: the child is not on the expected clock'); process.exit(1); }",
        "const optionsOk = process.env.PLANTED_OPTIONS_MATCH === 'prefix' ? options.startsWith(wanted + ' ') : options === wanted;",
        "if (!optionsOk) { console.error('FAIL: NODE_OPTIONS was not what this run should carry'); process.exit(1); }",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    interface PlantRun {
      shift: string | null;
      suiteShiftMs: number;
      childShiftMs: number;
      nodeOptions: string;
      optionsMatch: "exact" | "prefix";
    }
    const runPlant = (p: PlantRun) =>
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
            PLANTED_ANCHOR_MS: String((globalThis.__slateShiftedClock?.realDate ?? Date).now()),
            PLANTED_EXPECT_SHIFT_MS: String(p.suiteShiftMs),
            PLANTED_EXPECT_CHILD_SHIFT_MS: String(p.childShiftMs),
            PLANTED_EXPECT_OPTIONS: p.nodeOptions,
            PLANTED_OPTIONS_MATCH: p.optionsMatch,
            // Written out rather than inherited, for the same reason as above: under
            // the shifted workflow this suite's own NODE_OPTIONS already carries the
            // hook, and a control that took it would be measuring the outer run.
            NODE_OPTIONS: p.nodeOptions,
            [CLOCK_SHIFT_ENV]: p.shift ?? "",
            SLATE_CLOCK_SHIFT_QUIET: "1",
          },
        },
      );

    // The shifted run: the suite AND the node process it starts are a day ahead,
    // the suite is not shifted twice by being handed the hook two ways, and the
    // options the run was started with are kept ahead of the hook.
    const shifted = runPlant({
      shift: "+1d",
      suiteShiftMs: DAY_MS,
      childShiftMs: DAY_MS,
      nodeOptions: "--no-deprecation",
      optionsMatch: "prefix",
    });
    eq(
      shifted.status,
      0,
      `a node process a shifted suite starts reads the shifted clock${childDetail(shifted)}`,
    );

    // The ordinary run is unchanged: nobody's clock moves and NODE_OPTIONS is exactly
    // what the run was started with, so the normal suite pays nothing for this.
    const plain = runPlant({
      shift: null,
      suiteShiftMs: 0,
      childShiftMs: 0,
      nodeOptions: "--no-deprecation",
      optionsMatch: "exact",
    });
    eq(
      plain.status,
      0,
      `and an ordinary run leaves the child on the real clock and NODE_OPTIONS untouched${childDetail(plain)}`,
    );

    // The control that makes the two passes above mean something (L1): the same
    // shifted run, with the plant told to expect its child on the REAL clock, must
    // fail on the child. That is the pre #3361 expectation, so this is the check
    // that the plant can tell a shifted child from an unshifted one at all.
    const wrong = runPlant({
      shift: "+1d",
      suiteShiftMs: DAY_MS,
      childShiftMs: 0,
      nodeOptions: "--no-deprecation",
      optionsMatch: "prefix",
    });
    const wrongCaught =
      wrong.status === 1 && /child is not on the expected clock/.test(`${wrong.stdout}${wrong.stderr}`);
    assert(
      wrongCaught,
      `the plant fails on the child when told to expect it unshifted${wrongCaught ? "" : childDetail(wrong)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 5. the NODE_OPTIONS form survives a path with a space in it (#3361) ------
// NODE_OPTIONS is split on spaces, and the real checkout sits under a folder named
// with spaces and a curly apostrophe, so a hook named by its plain path reaches the
// child as several broken arguments. CI's checkout has no space in it, so section 4
// passing there says nothing about this; this section plants a hook under a path
// holding both characters wherever it runs, and asks a real child to load it.
{
  const dir = mkdtempSync(join(tmpdir(), "slate hook’s dir "));
  try {
    const hook = join(dir, "marker hook.mjs");
    writeFileSync(hook, "globalThis.__plantedHookLoaded = true;\n", "utf8");
    const probe = (nodeOptions: string) =>
      spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(String(globalThis.__plantedHookLoaded === true))"],
        { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: nodeOptions } },
      );

    const built = nodeOptionsWithHook(undefined, hook);
    assert(!/\s/.test(built), `the hook reference carries no whitespace (${built})`);
    const loaded = probe(built);
    eq(loaded.stdout, "true", `a child loads a hook under a path with a space and an apostrophe${childDetail(loaded)}`);

    const kept = nodeOptionsWithHook("  --no-deprecation ", hook);
    assert(kept.startsWith("--no-deprecation --import="), `options already set are kept ahead of the hook (${kept})`);
    eq(probe(kept).stdout, "true", "and the hook still loads behind them");

    // The control (L1): the plain path in the same place really does break, so the
    // pass above is a property of the form and not of a path that happened to be safe.
    const naive = probe(`--import=${hook}`);
    assert(
      naive.stdout !== "true",
      "the same hook named by its plain path does NOT load, so the encoding is what made it work",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function childDetail(r: { status: number | null; stdout: string; stderr: string }): string {
  return r.status === 0 ? "" : ` (exit ${r.status}: ${`${r.stdout}${r.stderr}`.trim().slice(-900)})`;
}

function detail(r: { status: number | null; stdout: string; stderr: string }): string {
  return r.status === 0 || r.status === 1
    ? ""
    : ` (exit ${r.status}: ${`${r.stdout}${r.stderr}`.trim().slice(-400)})`;
}

finish();
