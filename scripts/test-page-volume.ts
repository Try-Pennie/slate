// The per page low volume alarm (#2738). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-page-volume.ts
//
// Four things, in order:
//   1. the pages are the measurement's pages and the booking source vocabulary's;
//   2. the committed per page floors are what the committed measurement produces;
//   3. the check itself, through hand written fakes: what it reads, what it pages,
//      what it holds, and what it may clear;
//   4. the REPLAY: the shipped check, armed, every 5 minutes over the real measured
//      weeks, on the two held out weeks the per page fit never saw. The numbers it
//      prints are the evidence the PR quotes, including where a page is unmeasured.
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import {
  LOW_PAGES,
  PAGE_SEEN_LOOKBACK_DAYS,
  pageCoverage,
  pagePlaces,
  pageVolumeAlertKey,
  pageSourceStatus,
  sourceNotRecorded,
  runPageVolumeCheck,
  type LowPageId,
  type PageVerdict,
  type SourceRow,
} from "../src/lib/monitor/page-volume.ts";
import { MEASURED_PAGE_BASELINES } from "../src/lib/monitor/page-volume-baseline.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import type { BusinessHoursConfig } from "../src/lib/monitor/booking-volume.ts";
import { fitFloorCells, type BookingSeries, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { PAGE_SOURCES } from "../src/lib/booking/booking-source.ts";
import {
  FLOOR_SCOPE,
  OFFLINE_OPEN_WEEK,
  offlineHoursFor,
  pageBaselinesFromFixture,
  pageScope,
  renderPageBaselineModule,
  scopedSeries,
  type VolumeFixture,
} from "./lib/volume-floor-scope.ts";
import { headOf, replayLowVolume, replayPageVolume, withGap } from "./lib/volume-floor-replay.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const COOLDOWN = 30 * MIN; // MONITOR_DEFAULTS.cooldownMs.low_booking_volume, which the page keys share
const fixture = JSON.parse(readFileSync("scripts/fixtures/calcom-low-bookings.json", "utf8")) as VolumeFixture;
// The week the replays judge in: the stored week plus the closed days the measurement
// recorded (#2764), because the live alarm reads both.
const REPLAY_HOURS = offlineHoursFor(fixture);

// --- 1. the pages ---
{
  const forms = Object.keys(fixture.forms).sort();
  eq(LOW_PAGES.map((p) => p.calcomForm).sort(), forms, "the pages are exactly the measurement's Low routing forms");
  eq(FLOOR_SCOPE.forms, LOW_PAGES.map((p) => p.calcomForm), "the tier alarm's scope is derived from the same list");
  const all = LOW_PAGES.flatMap((p) => [...p.sources]);
  eq(new Set(all).size, all.length, "no source belongs to two pages, so a booking counts for one page only");
  assert(all.every((s) => (PAGE_SOURCES as readonly string[]).includes(s)), "every source is in the #2072 vocabulary");
  eq(new Set(LOW_PAGES.map((p) => p.id)).size, LOW_PAGES.length, "page ids are distinct, so each has its own alert key");
  eq(pagePlaces(LOW_PAGES[0]!), "/booking/portal and /offerhub", "a page's places come from the source vocabulary's own names");
}

// --- 2. the committed per page floors are the committed measurement's ---
{
  const derived = pageBaselinesFromFixture(fixture);
  assert(
    renderPageBaselineModule(derived) === readFileSync("src/lib/monitor/page-volume-baseline.ts", "utf8"),
    "src/lib/monitor/page-volume-baseline.ts is exactly what the committed measurement fits to (run REFIT=1 pnpm measure:volume-floors)",
  );
  assert(JSON.stringify(MEASURED_PAGE_BASELINES) === JSON.stringify(derived), "and the module evaluates to those baselines");
  for (const page of LOW_PAGES) {
    const b = MEASURED_PAGE_BASELINES[page.id];
    assert(b.tierShare !== null && b.tierShare > 0 && b.tierShare < 1, `${page.id} records its share of the tier`);
    assert(b.scope.includes(page.name), `${page.id}'s baseline names the page it was fitted to`);
  }
  const total = LOW_PAGES.reduce((s, p) => s + MEASURED_PAGE_BASELINES[p.id].bookings, 0);
  eq(total, MEASURED_VOLUME_BASELINE.bookings, "the pages' bookings add up to the tier's");
}

// --- 2. coverage: a floor of 0 is declared, never read as coverage ---
{
  const lines = LOW_PAGES.map((p) => pageCoverage(p, MEASURED_PAGE_BASELINES[p.id], OFFLINE_OPEN_WEEK));
  for (const c of lines) console.log(`coverage: ${c.text}`);
  const followUp = lines[1]!;
  eq(followUp.open, 72, "six open days of twelve hours");
  assert(followUp.judged < followUp.open / 2, "the 16% page is unmeasured in most of its open week");
  assert(/UNMEASURED/.test(followUp.text) && /53 are UNMEASURED/.test(followUp.text), "and it says so, with the count");
  const zeros: VolumeBaseline = {
    ...MEASURED_VOLUME_BASELINE,
    cells: MEASURED_VOLUME_BASELINE.cells.map((d) => d.map((c) => ({ ...c, floor30: 0, floor120: 0 }))),
  };
  const none = pageCoverage(LOW_PAGES[1]!, zeros, OFFLINE_OPEN_WEEK);
  assert(none.unmeasured && none.judged === 0, "a page no hour of which can breach is UNMEASURED as a whole");
  assert(/UNMEASURED\. It carries too few bookings/.test(none.text), "in its own words, not as a quiet page");
  // Only OPEN hours count: a floor of 0 at 3am is not a gap in coverage.
  const allOpen = pageCoverage(LOW_PAGES[2]!, MEASURED_PAGE_BASELINES["application-review"], {
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  });
  eq(allOpen.open, 168, "a week open around the clock counts every hour");
  assert(allOpen.judged < allOpen.open, "and the night hours then read as unmeasured, as they are");
}

// --- 2. #2765: whether the pages' own floors can be shown as coverage yet ---
// Measured over the per page alarm's lookback, by the same measurement the
// readiness gate reads (`measurePageSources`). Only a lookback in which every real
// booking carried a source shows floors; anything else says, in one sentence, how
// many did not, because a floor judged against bookings that cannot be told apart
// is not coverage (L11).
{
  const pages = LOW_PAGES.map((p) => ({ id: p.id, name: p.name, recorded: true }));
  const some = pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 3, pages });
  eq(some.state, "unrecorded", "any booking with no source in the lookback holds the floors back");
  assert(some.state === "unrecorded" && some.text.startsWith("Source not recorded on 3 of 40 bookings in the last 7 days"), `in those words (${some.state === "unrecorded" ? some.text : ""})`);
  const all = pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 40, pages: pages.map((p) => ({ ...p, recorded: false })) });
  assert(all.state === "unrecorded" && all.text.startsWith("Source not recorded on 40 of 40 bookings"), "the pre #2072 state, every booking unsourced, says so");
  const none = pageSourceStatus({ lookbackDays: 7, realBookings: 0, unsourced: 0, pages: pages.map((p) => ({ ...p, recorded: false })) });
  assert(none.state === "unmeasured" && /no real booking in the last 7 days/i.test(none.text), "no bookings at all is unmeasured, never recorded (L98)");
  eq(pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 0, pages }).state, "recorded", "only a lookback where every booking carried one shows floors");
  eq(pageSourceStatus(null).state, "unreadable", "a measurement that could not be taken is its own state");
  eq(sourceNotRecorded(1, 1, "7 days"), "Source not recorded on 1 of 1 booking in the last 7 days", "one booking reads in the singular");
}

// --- 3. the check, through fakes ---
const TUESDAY_2PM = DateTime.fromISO("2026-09-22T14:00", { zone: ZONE }).toMillis();
const SUNDAY_2PM = DateTime.fromISO("2026-09-20T14:00", { zone: ZONE }).toMillis();

/** A baseline with the same floors at every hour. */
function flat(floor30: number, floor120: number): VolumeBaseline {
  const cell: FloorCell = { floor30, floor120, typical120: Math.max(1, floor120 * 2) };
  return { ...MEASURED_VOLUME_BASELINE, cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ ...cell }))) };
}

function harness(opts: {
  baselines?: Partial<Record<LowPageId, VolumeBaseline>>;
  rows?: SourceRow[];
  readThrows?: boolean;
  seen?: boolean | "throws";
  tierLow?: boolean | null;
  armed?: boolean;
  nowMs?: number;
  businessHours?: BusinessHoursConfig;
}) {
  const calls = { reads: 0, seen: 0, sent: [] as { key: string; text: string }[], resolved: [] as { key: string; text: string }[] };
  const baselines = {
    "income-verification": flat(0, 2),
    "application-review-follow-up": flat(0, 1),
    "application-review": flat(1, 5),
    ...opts.baselines,
  } as Record<LowPageId, VolumeBaseline>;
  const run = () =>
    runPageVolumeCheck({
      nowMs: opts.nowMs ?? TUESDAY_2PM,
      businessHours: opts.businessHours ?? OFFLINE_OPEN_WEEK,
      baselines,
      readSources: async () => {
        calls.reads++;
        if (opts.readThrows) throw new Error("bookings read failed");
        return opts.rows ?? [];
      },
      pageSeenSince: async () => {
        calls.seen++;
        if (opts.seen === "throws") throw new Error("lookup failed");
        return opts.seen ?? true;
      },
      tierLow: opts.tierLow === undefined ? false : opts.tierLow,
      armed: opts.armed ?? true,
      cooldownMs: COOLDOWN,
      notify: async (key, _ms, text) => {
        calls.sent.push({ key, text });
      },
      resolveRecovered: async (recovered) => {
        calls.resolved.push(...recovered);
        return recovered.map((r) => r.key);
      },
    });
  return { calls, run };
}

const ago = (min: number, source: string | null): SourceRow => ({ createdMs: TUESDAY_2PM - min * MIN, source });
const verdictOf = (pages: PageVerdict[], id: LowPageId) => pages.find((p) => p.id === id)!;
const HEALTHY_ROWS: SourceRow[] = [
  ...[10, 40, 70].map((m) => ago(m, "offerhub")),
  ...[20, 80].map((m) => ago(m, "booking-agent-eligible")),
  ...[5, 15, 25, 50, 60, 90, 100].map((m) => ago(m, m % 2 ? "booking" : "my-offers-result")),
];

{
  // Outside the org's hours nothing is read, nothing is paged and nothing is cleared.
  const h = harness({ nowMs: SUNDAY_2PM });
  const out = await h.run();
  eq(out.status, "outside-hours", "Sunday is shut in the stored week");
  eq(h.calls.reads, 0, "nothing is read outside business hours");
  eq(h.calls.resolved.length, 0, "and nothing is cleared: a tick that measured nothing clears nothing");

  // #2764: a Tuesday the org records CLOSED is shut exactly as Sunday is, through the
  // same exceptions the booker refuses the day by, so a holiday pages nothing.
  const holiday = harness({ rows: [], businessHours: offlineHoursFor({ closedDates: ["2026-09-22"] }) });
  eq((await holiday.run()).status, "outside-hours", "a recorded closed day is outside business hours");
  eq(holiday.calls.reads + holiday.calls.sent.length + holiday.calls.resolved.length, 0, "and reads, pages and clears nothing");
  const control = harness({ rows: [] });
  await control.run();
  eq(control.calls.sent.length, 3, "control: the same silent Tuesday with no exception pages every page");
}
{
  // Every page healthy: one read for all three, every page's own key cleared, nothing paged.
  const h = harness({ rows: HEALTHY_ROWS });
  const out = await h.run();
  eq(h.calls.reads, 1, "one read serves every page");
  eq(h.calls.sent.length, 0, "healthy pages page nothing");
  eq(h.calls.resolved.map((r) => r.key).sort(), LOW_PAGES.map((p) => pageVolumeAlertKey(p.id)).sort(), "each measured page clears its own key");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "healthy"), "every page judged healthy");
  assert(/Completed Application Review page are back above the expected minimum: 3 in the last 30 min; 7 in the last 120 min/.test(h.calls.resolved.find((r) => r.key === pageVolumeAlertKey("application-review"))!.text), "the all-clear quotes the page's own measured counts");
}
{
  // Rows from other pages never count toward a page.
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "offerhub"), ago(10, "unrecognised"), ago(10, "rml-portal")] });
  const out = await h.run();
  const iv = verdictOf(out.status === "checked" ? out.pages : [], "income-verification");
  assert(iv.verdict === "low" && iv.windows[1]!.count === 0, "other pages' bookings do not count for Income Verification");
  eq(h.calls.sent.map((s) => s.key), [pageVolumeAlertKey("income-verification")], "only the quiet page pages, on its own key");
  const text = h.calls.sent[0]!.text;
  assert(text.includes("Income Verification Phone Call page (/booking/portal and /offerhub)"), "the page names the page and its URLs");
  assert(text.includes("0 in the last 120 min (expected at least 2, measured for Tuesdays 2pm to 3pm)"), "and quotes the measured count against its floor and where the floor came from");
  assert(text.includes("Low bookings overall are above their floor"), "and says the tier is fine, because the tier alarm measured that");
  assert(!h.calls.resolved.some((r) => r.key === pageVolumeAlertKey("income-verification")), "a low page is not cleared");
  eq(h.calls.resolved.length, 2, "the two healthy pages still clear");
}
{
  // #2765: a booking that recorded NO source might be any page's. While enough of them
  // arrived to make up a page's shortfall, whether that page stopped booking or its
  // links stopped carrying ?source= cannot be told apart, so it is held and SAYS so,
  // with the count, rather than paging against a floor it cannot judge (L11).
  const untagged = [ago(10, "not-given"), ago(30, null)];
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "offerhub"), ...untagged] });
  const out = await h.run();
  const iv = verdictOf(out.status === "checked" ? out.pages : [], "income-verification");
  assert(iv.verdict === "source-unrecorded", `a shortfall untagged bookings could make up is held (got ${iv.verdict})`);
  if (iv.verdict === "source-unrecorded") {
    eq([iv.unsourced, iv.total], [2, 11], "it counts the untagged bookings against every booking read");
    assert(/^Source not recorded on 2 of 11 bookings in the last 120 min/.test(iv.text), `and says so in those words: ${iv.text}`);
    assert(!/expected at least/.test(iv.text), "rather than presenting a floor");
  }
  eq(h.calls.sent.length, 0, "nothing is paged about it");
  assert(!h.calls.resolved.some((r) => r.key === pageVolumeAlertKey("income-verification")), "and nothing is cleared: it was not measured healthy");
  eq(h.calls.resolved.length, 2, "the pages measured healthy still clear");
  assert(out.status === "checked" && out.sources.unsourced === 2 && out.sources.total === 11, "the step reports the unsourced count for the whole read");

  // Too few untagged bookings to cover the shortfall: the page really is low, and pages.
  const short = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "offerhub"), ago(10, "not-given")] });
  await short.run();
  eq(short.calls.sent.map((s) => s.key), [pageVolumeAlertKey("income-verification")], "one untagged booking cannot make up a shortfall of two, so it pages");
  // Control in the same shape (L159): the untagged bookings removed, it pages too.
  const none = harness({ rows: HEALTHY_ROWS.filter((r) => r.source !== "offerhub") });
  const noneOut = await none.run();
  eq(none.calls.sent.length, 1, "control: with every booking tagged the quiet page pages");
  assert(noneOut.status === "checked" && noneOut.sources.unsourced === 0, "and the step reports none untagged");
  // The untagged bookings are ONE pool, spent once: three of them cannot be three
  // missing bookings of one page AND three of another. Pages are excused in the list's
  // own order until the pool is spent, and a page it cannot cover still pages.
  const shared = harness({
    baselines: { "income-verification": flat(0, 3), "application-review-follow-up": flat(0, 0), "application-review": flat(0, 3) },
    rows: [ago(10, "not-given"), ago(20, "not-given"), ago(30, null)],
  });
  const sharedOut = await shared.run();
  const sharedPages = sharedOut.status === "checked" ? sharedOut.pages : [];
  eq(verdictOf(sharedPages, "income-verification").verdict, "source-unrecorded", "the first short page takes the three untagged bookings");
  eq(verdictOf(sharedPages, "application-review").verdict, "low", "so the second, short by three too, cannot be excused by the same three");
  eq(shared.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review")], "and pages");
  // Control: six untagged bookings cover both, and nothing pages.
  const enough = harness({
    baselines: { "income-verification": flat(0, 3), "application-review-follow-up": flat(0, 0), "application-review": flat(0, 3) },
    rows: [10, 20, 30, 40, 50, 60].map((m) => ago(m, "not-given")),
  });
  await enough.run();
  eq(enough.calls.sent.length, 0, "control: a pool large enough for both short pages excuses both");
  // An unrecognised source is a link that NAMED a page, so it is not an untagged booking.
  const odd = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "offerhub"), ago(10, "unrecognised"), ago(20, "unrecognised")] });
  await odd.run();
  eq(odd.calls.sent.length, 1, "bookings with an unrecognised source do not hold a page");
}
{
  // Rows at or after now, or before the long window, are outside every window.
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "offerhub"), { createdMs: TUESDAY_2PM, source: "offerhub" }, ago(121, "offerhub")] });
  const out = await h.run();
  assert(out.status === "checked" && verdictOf(out.pages, "income-verification").verdict === "low", "a booking at the tick or before the window counts for nothing");
}
{
  // An hour a page cannot be judged in: no read at all when no page can be judged,
  // UNMEASURED in the result, and never an all-clear off a floor of 0 (L543, L90).
  const zeros = { "income-verification": flat(0, 0), "application-review-follow-up": flat(0, 0), "application-review": flat(0, 0) };
  const h = harness({ baselines: zeros });
  const out = await h.run();
  eq(h.calls.reads, 0, "an hour no page can be judged in reads nothing");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "unmeasured-hour"), "every page reports unmeasured, not healthy");
  eq(h.calls.resolved.length, 0, "and clears nothing: a floor of 0 measured nothing");
  eq(h.calls.sent.length, 0, "and pages nothing");

  const one = harness({ baselines: { "application-review-follow-up": flat(0, 0) }, rows: [] });
  const out1 = await one.run();
  const fu = out1.status === "checked" ? verdictOf(out1.pages, "application-review-follow-up") : null;
  eq(fu?.verdict, "unmeasured-hour", "one unmeasured page among judged ones is still reported unmeasured");
  assert(!one.calls.sent.some((s) => s.key === pageVolumeAlertKey("application-review-follow-up")), "it is never paged with zero bookings");
  assert(!one.calls.resolved.some((r) => r.key === pageVolumeAlertKey("application-review-follow-up")), "and never cleared");
}
{
  // Disarmed: judged and logged, never paged, and no lookup spent on it.
  const h = harness({ rows: [], armed: false });
  const out = await h.run();
  eq(h.calls.sent.length, 0, "a disarmed alarm pages nothing");
  eq(h.calls.seen, 0, "and asks nothing further");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "low" && p.action === "held-disarmed"), "every quiet page is held for the arming switch");
}
{
  // The tier alarm already reports the same silence: one page, not four.
  const h = harness({ rows: [], tierLow: true });
  const out = await h.run();
  eq(h.calls.sent.length, 0, "while the tier is low the pages hold");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "low" && p.action === "held-tier"), "and say why");
  // Positive control in the SAME fixture (L159): the tier unjudged, the pages page.
  const u = harness({ rows: [], tierLow: null });
  await u.run();
  eq(u.calls.sent.length, 3, "with the tier unjudged, every quiet page pages");
  assert(u.calls.sent.every((s) => !s.text.includes("Low bookings overall")), "without claiming a tier reading nobody made");
}
{
  // A page that has recorded nothing in the lookback is told apart from one that stopped.
  const h = harness({ rows: [], seen: false });
  const out = await h.run();
  eq(h.calls.sent.length, 3, "every quiet page still pages");
  const text = h.calls.sent[0]!.text;
  assert(text.includes(`No booking in the last ${PAGE_SEEN_LOOKBACK_DAYS} days`), "saying nothing has been recorded from it");
  assert(text.includes("source=booking-portal or source=offerhub"), "and naming the link parameter that tells pages apart");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "low" && p.action === "paged-unseen"), "recorded as an unseen page");
  const t = harness({ rows: [], seen: "throws" });
  await t.run();
  assert(t.calls.sent.every((s) => s.text.startsWith("Bookings from the")), "a lookup that failed keeps the ordinary wording, which the counts support");
}
{
  // A read that fails THROWS, so the lane's step boundary reports it; it never
  // becomes every page at zero, and it clears nothing.
  const h = harness({ readThrows: true });
  let threw = "";
  await h.run().catch((e: Error) => (threw = e.message));
  eq(threw, "bookings read failed", "the read's own failure propagates");
  eq(h.calls.sent.length, 0, "nothing is paged off a read that never came back");
  eq(h.calls.resolved.length, 0, "and nothing is cleared");
}

// --- 4. the replay ---
const series = Object.fromEntries(
  LOW_PAGES.map((p) => [p.id, scopedSeries(fixture, pageScope(fixture, p))]),
) as Record<LowPageId, BookingSeries>;
const per = fixture.bucketMinutes * MIN;
const n = series["application-review"].counts.length;
const endMs = fixture.startMs + n * per;
const holdoutFrom = endMs - 14 * DAY;
const trainN = n - (14 * DAY) / per;
const trained = Object.fromEntries(
  LOW_PAGES.map((p) => [p.id, { ...MEASURED_PAGE_BASELINES[p.id], cells: fitFloorCells(headOf(series[p.id], trainN), ZONE, fixture.closedDates) }]),
) as Record<LowPageId, VolumeBaseline>;
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc d LLL HH:mm");
const replay = (s: Record<LowPageId, BookingSeries>, fromMs: number, toMs: number, baselines = trained) =>
  replayPageVolume({ series: s, baselines, businessHours: REPLAY_HOURS, fromMs, toMs, tickMinutes: 5, cooldownMs: COOLDOWN });
{
  // HOLDOUT: fitted on the first seven weeks, replayed on the last two.
  const holdout = await replay(series, holdoutFrom, endMs);
  console.log(`replay: holdout ${fmt(holdoutFrom)} to ${fmt(endMs)}, ${holdout.checked} ticks judged, ${holdout.pages.length} pages`);
  for (const p of holdout.pages) console.log(`replay:   ${p.key} at ${fmt(p.atMs)}`);
  eq(holdout.checked, 12 * 144, "the holdout judged every open tick of two weeks, both Saturdays included");
  assert(holdout.pages.length <= 2, `at most two pages across three pages in two real weeks (${holdout.pages.length})`);

  // In sample, for the record: the committed floors over all nine weeks.
  const inSample = await replay(series, fixture.startMs + 2 * 60 * MIN, endMs, MEASURED_PAGE_BASELINES);
  console.log(`replay: all nine weeks with the committed floors, ${inSample.pages.length} pages`);
  for (const p of inSample.pages) console.log(`replay:   ${p.key} at ${fmt(p.atMs)}`);
  assert(inSample.pages.length <= 18, `at most about two pages a week across the three pages (${inSample.pages.length})`);

  // #2764: Labor Day (2026-09-07) is recorded closed in production, and the replay of
  // the shipped alarm, reading the same exceptions the monitor reads, pages nothing
  // on it. The control is the same nine weeks with the exceptions left out, which is
  // how #2738's replay ran, and it pages the Follow Up page on Labor Day morning.
  const dayOf = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toISODate() ?? "";
  eq(inSample.pages.filter((p) => fixture.closedDates.includes(dayOf(p.atMs))).length, 0, "no page on a day the org records closed");
  const unexcused = await replayPageVolume({
    series,
    baselines: MEASURED_PAGE_BASELINES,
    businessHours: OFFLINE_OPEN_WEEK,
    fromMs: fixture.startMs + 2 * 60 * MIN,
    toMs: endMs,
    tickMinutes: 5,
    cooldownMs: COOLDOWN,
  });
  const laborDay = unexcused.pages.filter((p) => dayOf(p.atMs) === "2026-09-07");
  console.log(`replay: the same nine weeks with no exceptions read pages ${laborDay.length} times on Labor Day`);
  assert(laborDay.length > 0, "control: judged as an open day, Labor Day pages, so the exception is what removed those pages");
  eq(
    unexcused.pages.filter((p) => dayOf(p.atMs) !== "2026-09-07").map((p) => `${p.key}@${p.atMs}`),
    inSample.pages.map((p) => `${p.key}@${p.atMs}`),
    "and every page on an open day is the same page either way: only the holiday's pages went",
  );
}

/** One page's series emptied inside [from, to), every other page left booking. */
const oneBroken = (id: LowPageId, from: number, to: number) => ({ ...series, [id]: withGap(series[id], from, to) });
const weekdays = (hour: number) => {
  const out: number[] = [];
  for (let d = 0; d < 14; d++) {
    const day = DateTime.fromMillis(holdoutFrom, { zone: ZONE }).startOf("day").plus({ days: d + 1 });
    const at = day.set({ hour }).toMillis();
    if (day.weekday <= 5 && at + 180 * MIN <= endMs) out.push(at);
  }
  return out;
};

// ONE PAGE BREAKS, the others keep booking, for three hours from each start hour:
// how many the per page alarm catches and how fast, beside the tier alarm on the
// same outage. This is the table #2738 asked to be measured before anything else.
const tierSeries = scopedSeries(fixture, FLOOR_SCOPE);
const tierPolicy = {
  baseline: { ...MEASURED_VOLUME_BASELINE, cells: fitFloorCells(headOf(tierSeries, trainN), ZONE, fixture.closedDates) },
  override30: null,
  override120: null,
};
const caught: Record<string, { hits: number; of: number }> = {};
for (const hour of [9, 10, 13, 16]) {
  for (const page of LOW_PAGES) {
    const delays: (number | null)[] = [];
    const tierDelays: (number | null)[] = [];
    let strays = 0;
    for (const from of weekdays(hour)) {
      const to = from + 180 * MIN;
      const r = await replay(oneBroken(page.id, from, to), from, to);
      const mine = r.pages.find((p) => p.key === pageVolumeAlertKey(page.id));
      delays.push(mine ? (mine.atMs - from) / MIN : null);
      strays += r.pages.filter((p) => p.key !== pageVolumeAlertKey(page.id)).length;
      const tierGap = {
        ...tierSeries,
        counts: tierSeries.counts.map((c, i) => {
          const at = tierSeries.startMs + i * per;
          return at >= from && at < to ? c - series[page.id].counts[i]! : c;
        }),
      };
      const t = await replayLowVolume({ series: tierGap, policy: tierPolicy, businessHours: REPLAY_HOURS, fromMs: from, toMs: to, tickMinutes: 5, cooldownMs: COOLDOWN });
      tierDelays.push(t.pages[0] ? (t.pages[0].atMs - from) / MIN : null);
    }
    eq(strays, 0, `a ${page.id} outage from ${hour}:00 pages about that page only`);
    const hits = delays.filter((d): d is number => d !== null);
    const tierHits = tierDelays.filter((d): d is number => d !== null);
    caught[`${page.id}@${hour}`] = { hits: hits.length, of: delays.length };
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : "-");
    console.log(
      `replay: ${page.id} broken from ${hour}:00 for 3h: per page caught ${hits.length}/${delays.length} ` +
        `(median ${med(hits)}m, worst ${hits.length ? Math.max(...hits) : "-"}m); tier alarm caught ${tierHits.length}/${tierDelays.length}`,
    );
  }
}
// What the per page alarm is FOR: the two pages the tier alarm cannot see at 1pm.
eq(caught["income-verification@13"], { hits: 9, of: 9 }, "a broken Income Verification page is caught every afternoon");
eq(caught["application-review@13"], { hits: 9, of: 9 }, "a broken Application Review page is caught every afternoon");
eq(caught["application-review-follow-up@9"], { hits: 9, of: 9 }, "a broken Follow Up page is caught every morning, where it is measured");
// And where it is NOT measured, the replay agrees with the declaration.
// "Mostly" as a share rather than a count: leaving Labor Day out of the fit (#2764)
// raised the Monday floors it had dragged down, which moved this from 2 of 9 to 4.
{
  const fu = caught["application-review-follow-up@13"]!;
  assert(fu.hits * 2 < fu.of, `a broken Follow Up page is mostly missed in the afternoon, where its floors are 0 (${fu.hits} of ${fu.of})`);
}

// Control in the same shape (L159): the same afternoons with every page booking page nothing.
{
  let pages = 0;
  for (const from of weekdays(13)) pages += (await replay(series, from, from + 180 * MIN)).pages.length;
  eq(pages, 0, "the same afternoons with their real bookings page nothing");
}

finish();
