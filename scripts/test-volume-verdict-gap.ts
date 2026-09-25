// The low volume alarm's verdict gap, judged in OPEN business minutes (#2049).
//
// The verdict family watches `verdict:low-booking-volume` against a flat 4 day
// bound, because the check is legitimately silent every Sunday and on holidays. A
// flat bound that clears a closed weekend cannot see ONE open day with no verdict:
// the check could stop concluding every Saturday and nothing would ever say so.
// This counts only the minutes the org was OPEN since the last verdict, so a whole
// missed Saturday is an hour of blindness by 09:00 and a long weekend is nothing.
//
// Run: node --experimental-strip-types scripts/test-volume-verdict-gap.ts
import {
  openMinutesBetween,
  runVolumeVerdictGapCheck,
  formatVolumeVerdictGapAlert,
  VOLUME_VERDICT_GAP_OPEN_MINUTES,
  VOLUME_VERDICT_GAP_COOLDOWN_MS,
  type VolumeVerdictGapResult,
} from "../src/lib/monitor/volume-verdict-gap.ts";
import {
  VOLUME_VERDICT_GAP_KEY,
  formatVolumeVerdictGapRecoveryNotice,
  type BusinessHoursConfig,
  type LowVolumeResult,
} from "../src/lib/monitor/booking-volume.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DASHES = new RegExp("[\\u2013\\u2014]");

/** The org's real stored week, measured live 2026-09-25: Monday to Saturday,
 *  08:00 to 20:00 Eastern, Sunday shut. */
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 }));
const CFG: BusinessHoursConfig = { zone: "America/New_York", rules: WEEK, exceptions: [] };
/** The same week with the one exception that was live over the reported gap. */
const WITH_LABOR_DAY: BusinessHoursConfig = {
  ...CFG,
  exceptions: [{ on_date: "2026-09-07", is_open: false, start_minute: null, end_minute: null, note: "Labor Day" }],
};

const at = (iso: string) => Date.parse(iso);

// The stamp #2049 quoted. 2026-09-05 was a SATURDAY: this is 19:56 EDT, the last
// in hours tick before Saturday's close, not a Friday one.
const SAT_CLOSE_TICK = at("2026-09-05T23:56:10Z");
const FRI_CLOSE_TICK = at("2026-09-18T23:56:00Z"); // Friday 19:56 EDT

// --- openMinutesBetween ---
{
  eq(
    openMinutesBetween(FRI_CLOSE_TICK, at("2026-09-19T12:02:00Z"), CFG),
    6,
    "Friday 19:56 to Saturday 08:02 is 4 open minutes before close plus 2 after open",
  );
  eq(
    openMinutesBetween(FRI_CLOSE_TICK, at("2026-09-19T23:56:00Z"), CFG),
    720,
    "a whole missed Saturday is 720 open minutes",
  );
  eq(
    openMinutesBetween(SAT_CLOSE_TICK, at("2026-09-08T12:02:00Z"), WITH_LABOR_DAY),
    5,
    "the reported gap, Saturday close to Tuesday open over a closed Sunday and Labor Day, is minutes, not days",
  );
  eq(
    openMinutesBetween(SAT_CLOSE_TICK, at("2026-09-08T12:02:00Z"), CFG),
    725,
    "without the Labor Day closure the same span holds a whole open Monday",
  );
  eq(openMinutesBetween(at("2026-09-19T03:00:00Z"), at("2026-09-19T11:00:00Z"), CFG), 0, "overnight is not open time");
  eq(openMinutesBetween(at("2026-09-20T13:00:00Z"), at("2026-09-20T20:00:00Z"), CFG), 0, "Sunday is not open time");
  eq(openMinutesBetween(at("2026-09-19T15:00:00Z"), at("2026-09-19T14:00:00Z"), CFG), 0, "a stamp in the future is no gap");
  // Across the November clock change: Saturday 19:00 EDT to Monday 09:00 EST.
  eq(
    openMinutesBetween(at("2026-10-31T23:00:00Z"), at("2026-11-02T14:00:00Z"), CFG),
    120,
    "the hours are judged in the org's own zone across a clock change",
  );
  // Judged in the zone the hours are stored in, not Eastern by assumption.
  const pacific: BusinessHoursConfig = { ...CFG, zone: "America/Los_Angeles" };
  eq(
    openMinutesBetween(at("2026-09-19T12:00:00Z"), at("2026-09-19T16:00:00Z"), pacific),
    60,
    "a Pacific org opens at 15:00Z, so 12:00Z to 16:00Z holds one open hour",
  );
  const shut: BusinessHoursConfig = { zone: "America/New_York", rules: [], exceptions: [] };
  eq(openMinutesBetween(FRI_CLOSE_TICK, at("2026-09-25T16:00:00Z"), shut), 0, "an org with no open day has no open time");
}

// --- runVolumeVerdictGapCheck ---
const CHECKED: LowVolumeResult = { status: "checked", armed: false, windows: [], breaches: [] };
const UNMEASURED: LowVolumeResult = { status: "unverified" };

function harness(o: {
  nowMs: number;
  volume?: LowVolumeResult;
  last?: number | null;
  readThrows?: boolean;
  notifyThrows?: boolean;
  hours?: BusinessHoursConfig;
}) {
  const notified: { key: string; cooldownMs: number; text: string }[] = [];
  let reads = 0;
  const run = (): Promise<VolumeVerdictGapResult> =>
    runVolumeVerdictGapCheck({
      nowMs: o.nowMs,
      businessHours: o.hours ?? CFG,
      volume: o.volume ?? UNMEASURED,
      readLastVerdictMs: async () => {
        reads++;
        if (o.readThrows) throw new Error("lane_heartbeats unreachable");
        return o.last === undefined ? null : o.last;
      },
      notify: async (key, cooldownMs, text) => {
        if (o.notifyThrows) throw new Error("slack down");
        notified.push({ key, cooldownMs, text });
      },
    });
  return { run, notified, get reads() { return reads; } };
}

const SAT_0905 = at("2026-09-19T13:05:00Z"); // Saturday 09:05 EDT: 69 open minutes after Friday's last tick
const SAT_0855 = at("2026-09-19T12:55:00Z"); // Saturday 08:55 EDT: 59 open minutes

// A tick that concluded is its own answer, and costs nothing: no read, no page.
{
  const h = harness({ nowMs: SAT_0905, volume: CHECKED, last: FRI_CLOSE_TICK });
  eq((await h.run()).status, "concluded", "a concluding tick is not a gap");
  eq(h.reads, 0, "a concluding tick reads no stamp");
  eq(h.notified.length, 0, "a concluding tick pages nothing");
}

// The issue's own shape, both directions around the bound: a Saturday on which
// the check has not concluded since Friday's close.
{
  const h = harness({ nowMs: SAT_0905, last: FRI_CLOSE_TICK });
  const res = await h.run();
  assert(res.status === "gap", "69 open minutes without a verdict is a gap");
  eq(h.notified.length, 1, "the gap pages once");
  eq(h.notified[0]?.key, VOLUME_VERDICT_GAP_KEY, "under its own key");
  eq(h.notified[0]?.cooldownMs, VOLUME_VERDICT_GAP_COOLDOWN_MS, "with its own cooldown");
  assert(h.notified[0]?.text.includes("69 minutes") ?? false, "the page says how much open time went unjudged");

  const early = harness({ nowMs: SAT_0855, last: FRI_CLOSE_TICK });
  const r2 = await early.run();
  assert(r2.status === "within", "59 open minutes is inside the bound");
  eq(early.notified.length, 0, "inside the bound nothing pages");
  eq(VOLUME_VERDICT_GAP_OPEN_MINUTES, 60, "the bound is one open hour");
}

// The reported gap itself is legitimate silence: Sunday shut, Labor Day shut.
{
  const h = harness({ nowMs: at("2026-09-08T12:30:00Z"), last: SAT_CLOSE_TICK, hours: WITH_LABOR_DAY });
  eq((await h.run()).status, "within", "Saturday close to Tuesday 08:30 over a holiday is 33 open minutes");
  eq(h.notified.length, 0, "and pages nothing");
  const noHoliday = harness({ nowMs: at("2026-09-08T12:30:00Z"), last: SAT_CLOSE_TICK });
  eq((await noHoliday.run()).status, "gap", "the same span with Monday open is a whole missed day");
}

// Outside hours nothing is judged and nothing is read.
{
  const h = harness({ nowMs: at("2026-09-20T15:00:00Z"), last: FRI_CLOSE_TICK });
  eq((await h.run()).status, "closed", "Sunday is closed");
  eq(h.reads, 0, "a closed tick reads nothing");
}

// A count the check could not read already pages under its own key, which names
// the query; a second page about the same tick would send a second reader to a
// different place (L36).
{
  const h = harness({ nowMs: SAT_0905, volume: { status: "count-unreadable" }, last: FRI_CLOSE_TICK });
  eq((await h.run()).status, "covered", "an unreadable count is paged elsewhere");
  eq(h.notified.length, 0, "and not here");
}

// Never stamped belongs to the verdict family's own grace window.
{
  const h = harness({ nowMs: SAT_0905, last: null });
  eq((await h.run()).status, "never-stamped", "a lane with no stamp at all is left to the verdict watch");
  eq(h.notified.length, 0, "and pages nothing here");
}

// An unparseable stamp reads as epoch 0 (#1169): ancient, so it pages.
{
  const h = harness({ nowMs: SAT_0905, last: 0 });
  eq((await h.run()).status, "gap", "an unreadable stamp is a gap, never fresh");
}

// A stamp read that fails THROWS, so the step boundary records it and the step
// streak pages (#2382), rather than reading as "no gap".
{
  const h = harness({ nowMs: SAT_0905, readThrows: true });
  let threw = false;
  await h.run().catch(() => (threw = true));
  assert(threw, "a failed stamp read throws rather than reporting within bounds");
}

// A Slack failure must not fail the tick.
{
  const h = harness({ nowMs: SAT_0905, last: FRI_CLOSE_TICK, notifyThrows: true });
  eq((await h.run()).status, "gap", "a failed notify still reports the gap");
}

// Copy.
{
  const page = formatVolumeVerdictGapAlert(69, FRI_CLOSE_TICK, "America/New_York");
  const hours = formatVolumeVerdictGapAlert(725, SAT_CLOSE_TICK, "America/New_York");
  const clear = formatVolumeVerdictGapRecoveryNotice();
  for (const t of [page, hours, clear]) {
    assert(!DASHES.test(t), "no em or en dash in the copy");
    assert(!t.startsWith("Slate"), "copy does not open with Slate");
  }
  assert(page.includes("Fri Sep 18 at 7:56pm EDT"), "the page names the last verdict in the org's zone");
  assert(hours.includes("12 hours"), "a long gap is said in hours");
  assert(hours.includes("Sat Sep 5 at 7:56pm EDT"), "the 2026-09-05 stamp renders as the Saturday it was");
}

finish();
