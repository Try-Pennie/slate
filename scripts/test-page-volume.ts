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
  LOW_PAGES_NOT_ON_SLATE,
  pagesOnSlate,
  LOW_PAGES_ON_SLATE,
  pagesNotOnSlateLines,
  isPageTraffic,
  pageTrafficFilter,
  isUnsourced,
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
import { API_SOURCES, BOOKING_SOURCES, PAGE_SOURCES } from "../src/lib/booking/booking-source.ts";
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
  const all = LOW_PAGES.flatMap((p) => [...p.sources]);
  eq(new Set(all).size, all.length, "no source belongs to two pages, so a booking counts for one page only");
  assert(all.every((s) => (PAGE_SOURCES as readonly string[]).includes(s)), "every source is in the #2072 vocabulary");
  eq(new Set(LOW_PAGES.map((p) => p.id)).size, LOW_PAGES.length, "page ids are distinct, so each has its own alert key");
  eq(pagePlaces(LOW_PAGES[0]!), "/booking/portal, /offerportal and the /portal-2 or /portal-3 calendar", "a page's places come from the source vocabulary's own names");

  // #2765: the values trypennie actually sends, typed out from its merged change
  // (Halo-lab-Trypennie/trypennie PR #516, merged 2026-09-29) rather than read off
  // LOW_PAGES (L70), each landing on the Low page whose cal.com form served it.
  const SENT_BY_TRYPENNIE: Record<string, LowPageId> = {
    "my-offers-result": "application-review", // /my-offers/result
    booking: "application-review", // /booking/[SO_ID], AI_Agent_Eligible__c false
    "booking-agent-eligible": "application-review-follow-up", // /booking/[SO_ID], eligible
    "booking-portal": "income-verification", // /booking/portal/[SO_ID]
    offerhub: "income-verification", // the offerhub modals
  };
  for (const [source, id] of Object.entries(SENT_BY_TRYPENNIE)) {
    const owners = LOW_PAGES.filter((p) => (p.sources as readonly string[]).includes(source)).map((p) => p.id);
    eq(owners, [id], `trypennie's source=${source} counts for the ${id} page, and only that page`);
  }
}

// --- 1. which Low pages send their leads to Slate (#2878) ---
{
  // Dan, 2026-09-29: the pilot launched on /booking/[SO_ID] and /my-offers/result,
  // and #2870 (trypennie #519, merged 2026-10-01) put Income Verification's surfaces
  // on Slate too, so every Low page is carried. Typed out here rather than read off
  // the switch, so the switch is checked against the decision and not against
  // itself (L70).
  const PILOT_PAGES: LowPageId[] = ["income-verification", "application-review-follow-up", "application-review"];
  const PILOT_FORMS = [
    "Completed Application Review (/booking ai_agent_eligible false and /my-offers/result)",
    "Completed Application Review Follow Up Routing (ai_agent_eligible true /booking)",
    "Income Verification Phone Call (engine /booking/portal and /offerhub)",
  ];
  eq(LOW_PAGES_ON_SLATE.map((p) => p.id), PILOT_PAGES, "Slate carries every Low page, in the measurement's own order");
  eq(
    LOW_PAGES_ON_SLATE.flatMap((p) => [...p.sources]).sort(),
    // #2873: /pennie and /my-offers/result-2 book the same Completed Application
    // Review form, so their sources count toward that page.
    ["booking", "booking-agent-eligible", "booking-portal", "income-landing", "my-offers-result", "my-offers-result-2", "offerhub", "pennie"],
    "which are every source a Low page sends",
  );
  eq([...FLOOR_SCOPE.forms].sort(), PILOT_FORMS, "the Low floors are fitted to every Low form");
  eq(
    FLOOR_SCOPE.forms,
    LOW_PAGES_ON_SLATE.map((p) => p.calcomForm),
    "derived from the one switch, so the floors and the judged pages cannot disagree (L41)",
  );
  for (const page of LOW_PAGES_ON_SLATE) {
    assert(FLOOR_SCOPE.label.includes(page.name), `the scope's plain words name ${page.name} (${FLOOR_SCOPE.label})`);
  }

  // #2870: trypennie's #519 (merged 2026-10-01) put /offerportal, /portal, the
  // offerhub modals and /booking/portal behind the Slate switch, so every Low page
  // sends its leads to Slate and every one is judged.
  eq(LOW_PAGES_ON_SLATE.map((p) => p.id), LOW_PAGES.map((p) => p.id), "every Low page is on Slate");
  eq(Object.keys(LOW_PAGES_NOT_ON_SLATE), [], "and none is held off");
  assert(FLOOR_SCOPE.label.includes("Income Verification"), `the Low floors take Income Verification in (${FLOOR_SCOPE.label})`);
  eq(pagesNotOnSlateLines(), [], "so no surface says a page is not judged");
  // The switch is empty today, so its held off path is driven with a sample entry
  // rather than left untested until the next page is held back.
  const sample = { "income-verification": { reason: "come from a page not wired to Slate", issue: 1 } } as const;
  eq(pagesOnSlate(sample).map((p) => p.id), ["application-review-follow-up", "application-review"], "a held off page leaves the carried set");
  const held = pagesNotOnSlateLines(sample);
  eq(held, ["Income Verification Phone Call is not judged: its leads come from a page not wired to Slate."], "and is stated in plain words");
  assert(!/[\u2014\u2013]/.test(held[0]!), "with no dash");
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
  // #2878: the Low floors are fitted to the pages Slate carries, so those pages'
  // bookings add up to the floors' bookings (every Low page since #2870).
  const total = LOW_PAGES_ON_SLATE.reduce((s, p) => s + MEASURED_PAGE_BASELINES[p.id].bookings, 0);
  eq(total, MEASURED_VOLUME_BASELINE.bookings, "the carried pages' bookings add up to the Low floors' bookings");
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
    "income-verification": flat(0, 1),
    "application-review-follow-up": flat(0, 2),
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
  ...[30, 75].map((m) => ago(m, m === 30 ? "offerhub" : "booking-portal")),
  ...[20, 80].map((m) => ago(m, "booking-agent-eligible")),
  ...[5, 15, 25, 50, 60, 90, 100].map((m) => ago(m, m % 2 ? "booking" : "my-offers-result")),
];

{
  // #2870: Income Verification is judged now. Silent under floors it should clear,
  // it pages under its own key, and its offerhub and booking portal bookings are
  // what clear it.
  const IV_SOURCES = new Set(["offerhub", "booking-portal", "income-landing"]);
  const silent = harness({ rows: HEALTHY_ROWS.filter((r) => !IV_SOURCES.has(r.source ?? "")), baselines: { "income-verification": flat(1, 3) } });
  const out = await silent.run();
  assert(out.status === "checked" && verdictOf(out.pages, "income-verification").verdict !== "healthy", "a silent Income Verification page is not healthy");
  assert(silent.calls.sent.some((s) => s.key === pageVolumeAlertKey("income-verification")), "and pages under its own key");
  // Control in the SAME fixture (L159): the other pages are healthy and clear.
  for (const id of ["application-review-follow-up", "application-review"] as const) {
    assert(out.status === "checked" && verdictOf(out.pages, id).verdict === "healthy", `control: ${id} is healthy beside it`);
  }

  const booking = harness({
    rows: [...HEALTHY_ROWS, ...[10, 40, 70].map((m) => ago(m, "offerhub")), ...[25, 95].map((m) => ago(m, "booking-portal"))],
    baselines: { "income-verification": flat(1, 3) },
  });
  const bookingOut = await booking.run();
  assert(bookingOut.status === "checked" && verdictOf(bookingOut.pages, "income-verification").verdict === "healthy", "offerhub and booking portal bookings keep it healthy");
  assert(booking.calls.resolved.some((r) => r.key === pageVolumeAlertKey("income-verification")), "and clear it");
}

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
  eq(control.calls.sent.length, 3, "control: the same silent Tuesday with no exception pages every page Slate carries");
}
{
  // Every page healthy: one read for every page, every page's own key cleared, nothing paged.
  const h = harness({ rows: HEALTHY_ROWS });
  const out = await h.run();
  eq(h.calls.reads, 1, "one read serves every page");
  eq(h.calls.sent.length, 0, "healthy pages page nothing");
  eq(h.calls.resolved.map((r) => r.key).sort(), LOW_PAGES_ON_SLATE.map((p) => pageVolumeAlertKey(p.id)).sort(), "each measured page clears its own key");
  assert(out.status === "checked" && out.pages.every((p) => p.verdict === "healthy"), "every page judged healthy");
  assert(/Completed Application Review page are back above the expected minimum: 3 in the last 30 min; 7 in the last 120 min/.test(h.calls.resolved.find((r) => r.key === pageVolumeAlertKey("application-review"))!.text), "the all-clear quotes the page's own measured counts");
}
{
  // Rows from other pages never count toward a page.
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), ago(10, "unrecognised"), ago(10, "rml-portal")] });
  const out = await h.run();
  const fu = verdictOf(out.status === "checked" ? out.pages : [], "application-review-follow-up");
  assert(fu.verdict === "low" && fu.windows[1]!.count === 0, "other pages' bookings do not count for the Follow Up page");
  eq(h.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review-follow-up")], "only the quiet page pages, on its own key");
  const text = h.calls.sent[0]!.text;
  assert(text.includes("Completed Application Review Follow Up page (/booking, eligible for the AI agent)"), "the page names the page and its URLs");
  assert(text.includes("0 in the last 120 min (expected at least 2, measured for Tuesdays 2pm to 3pm)"), "and quotes the measured count against its floor and where the floor came from");
  assert(text.includes("Low bookings overall are above their floor"), "and says the tier is fine, because the tier alarm measured that");
  assert(!h.calls.resolved.some((r) => r.key === pageVolumeAlertKey("application-review-follow-up")), "a low page is not cleared");
  eq(h.calls.resolved.length, 2, "the two healthy pages still clear");
}
{
  // #2765: a booking that recorded NO source might be any page's. While enough of them
  // arrived to make up a page's shortfall, whether that page stopped booking or its
  // links stopped carrying ?source= cannot be told apart, so it is held and SAYS so,
  // with the count, rather than paging against a floor it cannot judge (L11).
  const untagged = [ago(10, "not-given"), ago(30, null)];
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), ...untagged] });
  const out = await h.run();
  const fu = verdictOf(out.status === "checked" ? out.pages : [], "application-review-follow-up");
  assert(fu.verdict === "source-unrecorded", `a shortfall untagged bookings could make up is held (got ${fu.verdict})`);
  if (fu.verdict === "source-unrecorded") {
    eq([fu.unsourced, fu.total], [2, 11], "it counts the untagged bookings against every booking read");
    assert(/^Source not recorded on 2 of 11 bookings in the last 120 min/.test(fu.text), `and says so in those words: ${fu.text}`);
    assert(!/expected at least/.test(fu.text), "rather than presenting a floor");
  }
  eq(h.calls.sent.length, 0, "nothing is paged about it");
  assert(!h.calls.resolved.some((r) => r.key === pageVolumeAlertKey("application-review-follow-up")), "and nothing is cleared: it was not measured healthy");
  eq(h.calls.resolved.length, 2, "the two pages measured healthy still clear");
  assert(out.status === "checked" && out.sources.unsourced === 2 && out.sources.total === 11, "the step reports the unsourced count for the whole read");

  // Too few untagged bookings to cover the shortfall: the page really is low, and pages.
  const short = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), ago(10, "not-given")] });
  await short.run();
  eq(short.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review-follow-up")], "one untagged booking cannot make up a shortfall of two, so it pages");
  // Control in the same shape (L159): the untagged bookings removed, it pages too.
  const none = harness({ rows: HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible") });
  const noneOut = await none.run();
  eq(none.calls.sent.length, 1, "control: with every booking tagged the quiet page pages");
  assert(noneOut.status === "checked" && noneOut.sources.unsourced === 0, "and the step reports none untagged");
  // The untagged bookings are ONE pool, spent once: three of them cannot be three
  // missing bookings of one page AND three of another. Pages are excused in the list's
  // own order until the pool is spent, and a page it cannot cover still pages.
  const shared = harness({
    baselines: { "income-verification": flat(0, 0), "application-review-follow-up": flat(0, 3), "application-review": flat(0, 3) },
    rows: [ago(10, "not-given"), ago(20, "not-given"), ago(30, null)],
  });
  const sharedOut = await shared.run();
  const sharedPages = sharedOut.status === "checked" ? sharedOut.pages : [];
  eq(verdictOf(sharedPages, "application-review-follow-up").verdict, "source-unrecorded", "the first short page takes the three untagged bookings");
  eq(verdictOf(sharedPages, "application-review").verdict, "low", "so the second, short by three too, cannot be excused by the same three");
  eq(shared.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review")], "and pages");
  // Control: six untagged bookings cover both, and nothing pages.
  const enough = harness({
    baselines: { "income-verification": flat(0, 0), "application-review-follow-up": flat(0, 3), "application-review": flat(0, 3) },
    rows: [10, 20, 30, 40, 50, 60].map((m) => ago(m, "not-given")),
  });
  await enough.run();
  eq(enough.calls.sent.length, 0, "control: a pool large enough for both short pages excuses both");
  // #2795: the pool is BOOKINGS, not one count per window. The 30 minute window sits
  // inside the 120, so one untagged booking 10 minutes old is in both, and it can be
  // the missing booking of ONE page only: never one page's 30 minute shortfall and a
  // different page's 120 minute shortfall at once (L11).
  const acrossWindows = {
    "income-verification": flat(0, 0),
    "application-review-follow-up": flat(1, 0),
    "application-review": flat(0, 1),
  };
  const across = harness({ baselines: acrossWindows, rows: [ago(10, "not-given")] });
  const acrossOut = await across.run();
  const acrossPages = acrossOut.status === "checked" ? acrossOut.pages : [];
  eq(verdictOf(acrossPages, "application-review-follow-up").verdict, "source-unrecorded", "the page short in the 30 minute window takes the one untagged booking");
  eq(verdictOf(acrossPages, "application-review").verdict, "low", "so the page short only in the 120 minute window cannot be excused by the same booking");
  eq(across.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review")], "and pages");
  // Positive control in the same shape (L159): with only one page short, the one
  // untagged booking still excuses it, in either window.
  for (const [id, floors] of [
    ["application-review-follow-up", flat(1, 0)],
    ["application-review", flat(0, 1)],
  ] as const) {
    const alone = harness({
      baselines: { "income-verification": flat(0, 0), "application-review-follow-up": flat(0, 0), "application-review": flat(0, 0), [id]: floors },
      rows: [ago(10, "not-given")],
    });
    const aloneOut = await alone.run();
    eq(verdictOf(aloneOut.status === "checked" ? aloneOut.pages : [], id).verdict, "source-unrecorded", `control: one untagged booking still excuses ${id} when it is the only page short`);
    eq(alone.calls.sent.length, 0, `control: and nothing pages about ${id}`);
  }
  // A page short in BOTH windows by one needs only one booking inside the 30 minutes,
  // because that booking counts in both windows. A second, older untagged booking is
  // then left for another page's 120 minute shortfall.
  const both = harness({
    baselines: { "income-verification": flat(0, 0), "application-review-follow-up": flat(1, 1), "application-review": flat(0, 1) },
    rows: [ago(10, "not-given"), ago(90, null)],
  });
  await both.run();
  eq(both.calls.sent.length, 0, "one booking covers a page's shortfall in both windows, and an older one covers another page's 120 minutes");
  // But the older booking cannot cover a 30 minute shortfall: it is outside that window.
  const tooOld = harness({
    baselines: { "income-verification": flat(0, 0), "application-review-follow-up": flat(0, 1), "application-review": flat(1, 0) },
    rows: [ago(10, "not-given"), ago(90, null)],
  });
  await tooOld.run();
  eq(tooOld.calls.sent.length, 0, "the 120 minute shortfall is covered by the older booking, leaving the recent one for the 30 minute shortfall");
  // An unrecognised source is a link that NAMED a page, so it is not an untagged booking.
  const odd = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), ago(10, "unrecognised"), ago(20, "unrecognised")] });
  await odd.run();
  eq(odd.calls.sent.length, 1, "bookings with an unrecognised source do not hold a page");

  // #2876: a booking made through the booking API is not page traffic. It names its
  // caller rather than no page, so it can never excuse a page's shortfall (a steady
  // stream of Regal or trypennie API bookings would otherwise hide a dark page), and
  // it is left out of the count the unsourced share is quoted against.
  for (const s of API_SOURCES) {
    assert(!isUnsourced(s), `${s} is not an unsourced booking`);
    assert(!isPageTraffic(s), `${s} is not page traffic`);
  }
  for (const s of [...PAGE_SOURCES, "not-given", "unrecognised", null]) {
    assert(isPageTraffic(s), `${s ?? "null"} is page traffic, or might be`);
  }
  // The database filter the tier count and the floor learner send says exactly what
  // the predicate says, over every value the column can hold and null (L16).
  {
    const f = pageTrafficFilter();
    const m = /^source\.is\.null,source\.not\.in\.\(([^)]*)\)$/.exec(f);
    assert(m !== null, `the page traffic filter has the one shape the reads rely on (${f})`);
    const excluded = new Set((m?.[1] ?? "").split(","));
    for (const s of [...BOOKING_SOURCES, null]) {
      const passes = s === null || !excluded.has(s);
      eq(passes, isPageTraffic(s), `the filter and isPageTraffic agree on ${s ?? "null"}`);
    }
  }
  const quietRows = HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible");
  const viaApi = harness({ rows: [...quietRows, ago(10, "api-regal"), ago(20, "api-trypennie"), ago(40, "api-canary")] });
  const viaApiOut = await viaApi.run();
  eq(viaApi.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review-follow-up")], "API bookings do not hold a quiet page: it still pages");
  assert(
    viaApiOut.status === "checked" && viaApiOut.sources.unsourced === 0 && viaApiOut.sources.total === quietRows.length,
    `and the step counts neither API booking as unsourced nor as page traffic read (${JSON.stringify(viaApiOut.status === "checked" ? viaApiOut.sources : null)})`,
  );
  // Control in the same shape (L159): the same three bookings with no caller named
  // are unsourced, and they DO hold the page.
  const noCaller = harness({ rows: [...quietRows, ago(10, "not-given"), ago(20, "not-given"), ago(40, "not-given")] });
  await noCaller.run();
  eq(noCaller.calls.sent.length, 0, "control: three bookings naming nothing hold the page, so the API ones were the difference");
}
{
  // Rows at or after now, or before the long window, are outside every window.
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), { createdMs: TUESDAY_2PM, source: "booking-agent-eligible" }, ago(121, "booking-agent-eligible")] });
  const out = await h.run();
  assert(out.status === "checked" && verdictOf(out.pages, "application-review-follow-up").verdict === "low", "a booking at the tick or before the window counts for nothing");
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
  const text = h.calls.sent.find((s) => s.key === pageVolumeAlertKey("application-review-follow-up"))!.text;
  assert(text.includes(`No booking in the last ${PAGE_SEEN_LOOKBACK_DAYS} days`), "saying nothing has been recorded from it");
  assert(text.includes("source=booking-agent-eligible"), "and naming the link parameter that tells pages apart");
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
  for (const page of LOW_PAGES_ON_SLATE) {
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
// #2870: Income Verification is on Slate, so its series going silent at 1pm is
// caught by the per page alarm, which the tier alarm mostly cannot see (#2738).
eq(caught["income-verification@13"], { hits: 9, of: 9 }, "a broken Income Verification page is caught every afternoon");
// What the per page alarm is FOR: a page the tier alarm cannot see alone at 1pm.
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
