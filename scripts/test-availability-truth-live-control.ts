// Pure logic for the availability-truth LIVE positive control (#1377). Run:
//   node --experimental-strip-types scripts/test-availability-truth-live-control.ts
//
// Why this exists. The drift probe (#1315) is built to fail safe: a calendar it
// cannot read is scored `unverified`, never `drift`. That is right, and it means
// a probe whose Google reads never succeed is INDISTINGUISHABLE from a probe
// finding nothing wrong. Production confirmed the sharper version of that on
// 2026-08-11: every tick since deploy skipped with "bucket is offering no times
// to check", because the roster is deliberately dark before cutover (#1272), so
// the live calendar half had never executed once.
//
// So the probe cannot prove itself from production traffic. The control below
// proves it out of band, and the only thing that makes the proof worth anything
// is that it checks BOTH directions (L1): a window we independently know is busy
// must come back `drift`, and one we independently know is free must come back
// `free`. A one-sided control is satisfied by a probe that answers the same way
// every time.
import {
  pickControlWindows,
  judgeControlVerdicts,
  type BusyInterval,
} from "./lib/availability-truth-live-control.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 7, 11, 14, 0, 0);
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();
const at = (startMin: number, endMin: number): BusyInterval => ({
  start: iso(startMin),
  end: iso(endMin),
});

const DURATION = 30 * MIN;
const HORIZON = 14 * 24 * 60 * MIN;
const STEP = 30 * MIN;
const opts = { nowMs: NOW, horizonMs: HORIZON, durationMs: DURATION, stepMs: STEP };

// --- the busy control: a window we know is occupied, taken from Google's own answer ---
{
  const pick = pickControlWindows([at(120, 180), at(300, 330)], opts);
  assert(pick.ok, "a calendar with a long enough busy interval yields both controls");
  if (pick.ok) {
    eq(
      { startIso: pick.windows.busy.startIso, endIso: pick.windows.busy.endIso },
      { startIso: iso(120), endIso: iso(150) },
      "the busy window sits INSIDE the first long-enough busy interval",
    );
  }
}
{
  // A 20-minute meeting cannot host a 30-minute control window: taking it anyway
  // would leave 10 minutes of genuinely free time in the window, and the probe
  // would correctly answer `free` while the control called that a failure.
  const pick = pickControlWindows([at(120, 140), at(300, 400)], opts);
  assert(pick.ok, "a too-short interval is skipped, not used");
  if (pick.ok) {
    eq(pick.windows.busy.startIso, iso(300), "the first interval long enough to hold the window wins");
  }
}
{
  const pick = pickControlWindows([at(-600, -540)], opts);
  assert(!pick.ok, "a calendar whose only busy time is in the past yields no busy control");
  if (!pick.ok) assert(/busy/i.test(pick.why), "and says which control it could not build");
}
{
  // An interval that STARTED before now but runs well past it is still usable:
  // the window just starts at now rather than at the interval's start.
  const pick = pickControlWindows([at(-30, 180)], opts);
  assert(pick.ok, "an in-progress busy interval with enough left on it is usable");
  if (pick.ok) {
    eq(pick.windows.busy.startIso, iso(0), "the window starts at now, not in the past");
  }
}
{
  const pick = pickControlWindows([], opts);
  assert(!pick.ok, "an EMPTY calendar is refused, not scored as a pass");
}

// --- the free control: a window nothing overlaps ---
{
  const pick = pickControlWindows([at(0, 240)], opts);
  assert(pick.ok, "a busy morning still leaves a free window later");
  if (pick.ok) {
    eq(pick.windows.free.startIso, iso(240), "the free window starts once the busy run ends");
    eq(pick.windows.free.endIso, iso(270), "and runs for the booking duration");
  }
}
{
  // The gap between two meetings is exactly the duration, so it qualifies. A
  // half-open comparison is the whole point: an interval ENDING when the window
  // starts does not overlap it.
  const pick = pickControlWindows([at(0, 60), at(90, 240)], { ...opts, stepMs: 30 * MIN });
  assert(pick.ok, "an exactly-duration gap between meetings is free");
  if (pick.ok) eq(pick.windows.free.startIso, iso(60), "the gap is used rather than skipped past");
}
{
  const wall: BusyInterval[] = [];
  for (let d = 0; d < 15; d += 1) wall.push(at(d * 1440, (d + 1) * 1440));
  const pick = pickControlWindows(wall, opts);
  assert(!pick.ok, "a calendar busy for the whole horizon yields no free control");
  if (!pick.ok) assert(/free/i.test(pick.why), "and says which control it could not build");
}

// --- unreadable bounds poison the control set, they do not shrink it ---
{
  const pick = pickControlWindows([{ start: "not a date", end: iso(180) }, at(300, 400)], opts);
  assert(!pick.ok, "an unreadable busy bound refuses the whole control set");
  if (!pick.ok) assert(/unreadable/i.test(pick.why), "and says so, rather than silently dropping it");
}

{
  // parseStampMs treats an EMPTY bound as unreadable too, which a bare
  // Date.parse/isFinite pair would also catch but only by accident. Google
  // omitting a bound must land on the same refusal as garbage in one.
  const pick = pickControlWindows([{ start: "", end: iso(180) }], opts);
  assert(!pick.ok, "a MISSING busy bound is refused, not treated as the epoch");
}

// --- judging the pair: both directions, or it proves nothing ---
{
  eq(judgeControlVerdicts("drift", "free"), { ok: true, failures: [] }, "busy reads drift and free reads free");
}
{
  const j = judgeControlVerdicts("unverified", "free");
  assert(!j.ok, "an unverified busy control is a FAILURE, not a skip");
  assert(
    j.failures.some((f) => /could not be read|unverified/i.test(f)),
    "and names the unreadable calendar as the cause",
  );
}
{
  const j = judgeControlVerdicts("free", "free");
  assert(!j.ok, "a known-busy window reading free means the probe is not seeing the calendar");
  assert(j.failures.some((f) => /busy/i.test(f)), "and the failure names the busy control");
}
{
  const j = judgeControlVerdicts("drift", "unverified");
  assert(!j.ok, "an unverified free control is a failure too");
}
{
  const j = judgeControlVerdicts("drift", "drift");
  assert(!j.ok, "a known-free window reading drift means the probe is answering busy for everything");
  assert(j.failures.some((f) => /free/i.test(f)), "and the failure names the free control");
}
{
  const j = judgeControlVerdicts("unverified", "unverified");
  eq(j.failures.length, 2, "two broken directions are reported as two failures, not one");
}

finish();
