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
  isHostlessUnsourced,
  hostlessNotCounted,
  PAGE_SEEN_LOOKBACK_DAYS,
  pageCoverage,
  pageLinkLines,
  pageVolumeAlertKey,
  formatPageVolumeAlert,
  formatPageUnseenAlert,
  formatPageSourceUnrecorded,
  pageSourceStatus,
  sourceNotRecorded,
  runPageVolumeCheck,
  lowPilot,
  pilotPageLine,
  PILOT_LOW_TIER_DIGIT,
  PAGE_VOLUME_PILOT_UNKNOWN_KEY,
  PAGE_VOLUME_PILOT_UNKNOWN_COOLDOWN_MS,
  type LowPilot,
  type HeldOffSlate,
  type LowPageId,
  type PageVerdict,
  type SourceRow,
} from "../src/lib/monitor/page-volume.ts";
import { MEASURED_PAGE_BASELINES } from "../src/lib/monitor/page-volume-baseline.ts";
import type { PilotSettings } from "../src/lib/salesforce/pilot-settings.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import type { BusinessHoursConfig } from "../src/lib/monitor/booking-volume.ts";
import { fitFloorCells, type BookingSeries, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import {
  API_SOURCES,
  BOOKING_SOURCES,
  LANDING_HOST,
  PAGE_SOURCES,
  PROSPECT_ID,
  SOURCE_DETAILS,
  SUBMISSION_ID,
  type PageSource,
  type SourceDetail,
} from "../src/lib/booking/booking-source.ts";
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

// --- 1. every page an alert names carries a link a reader can open (#3033) ---
{
  // The guard, written once so its positive control runs the same predicate. It is
  // derived from LOW_PAGES, so a page or source added later is covered by
  // construction rather than by remembering to list it here (L96).
  const missingLinks = (details: Readonly<Record<string, Pick<SourceDetail, "links">>>): string[] =>
    LOW_PAGES.flatMap((p) => p.sources.filter((s) => (details[s]?.links.length ?? 0) === 0));
  eq(missingLinks(SOURCE_DETAILS), [], "every source a Low page carries has at least one link");
  // Positive control (L1): take one source's links away and the guard must name it.
  const victim: PageSource = LOW_PAGES[1]!.sources[0]!;
  const stripped = { ...SOURCE_DETAILS, [victim]: { ...SOURCE_DETAILS[victim], links: [] } };
  eq(missingLinks(stripped), [victim], "a source with no link fails the coverage check, by name");

  for (const page of LOW_PAGES) {
    for (const s of page.sources) {
      for (const link of SOURCE_DETAILS[s].links) {
        eq(new URL(link.url).origin, LANDING_HOST, `${s}: ${link.url} is on the production host`);
        assert(!/\s/.test(link.url), `${s}: ${link.url} holds no space, so Slack links all of it`);
        const holder = link.id === "submission" ? SUBMISSION_ID : PROSPECT_ID;
        assert(link.url.includes(holder), `${s}: ${link.url} marks where the ${link.id} id goes`);
      }
    }
  }
  // The AI agent eligible variant shares its address with the ordinary one, so the
  // link must say which lead shows it, and the two must not say the same thing.
  const eligible = SOURCE_DETAILS["booking-agent-eligible"].links;
  const ordinary = SOURCE_DETAILS.booking.links;
  eq(eligible.map((l) => l.url), ordinary.map((l) => l.url), "both /booking variants live at one address");
  assert(eligible.every((l) => /^a lead marked eligible for the AI agent$/.test(l.only ?? "")), "the eligible variant says which lead shows it");
  assert(ordinary.every((l) => /^a lead not marked eligible for the AI agent$/.test(l.only ?? "")), "and the ordinary one says the opposite");

  // Every page's link lines, which all three alerts carry.
  const income = pageLinkLines(LOW_PAGES[0]!);
  for (const u of [
    `${LANDING_HOST}/booking/portal/${SUBMISSION_ID}`,
    `${LANDING_HOST}/offerportal/${PROSPECT_ID}`,
    `${LANDING_HOST}/offerportal-2/${PROSPECT_ID}`,
    `${LANDING_HOST}/portal-2/${PROSPECT_ID}`,
    `${LANDING_HOST}/portal-3/${PROSPECT_ID}`,
  ]) {
    assert(income.split("\n").includes(u), `Income Verification lists ${u} on its own line`);
  }
  assert(/never a customer's/.test(income), "a page opened with a prospect id warns that opening it can create a lead");
  const review = pageLinkLines(LOW_PAGES[2]!);
  assert(!/prospect/i.test(review), "a page with no prospect link says nothing about prospects");
  assert(review.includes(`${LANDING_HOST}/my-offers/result?submission_id=${SUBMISSION_ID}`), "the result page takes its id as a query parameter");
  for (const page of LOW_PAGES) {
    const lines = pageLinkLines(page);
    const breach = [{ label: "120 min", count: 0, floor: 1 }];
    for (const [name, text] of [
      ["the volume alert", formatPageVolumeAlert(page, breach, true)],
      ["the unseen alert", formatPageUnseenAlert(page, breach)],
      ["the source unrecorded text", formatPageSourceUnrecorded(page, 2, 11)],
    ] as const) {
      assert(text.endsWith(lines), `${page.id}: ${name} ends with the page's links`);
      assert(text.includes("shows Slate's booker only"), `${page.id}: ${name} says what has to be true to see the booker`);
    }
  }
  const followUp = formatPageVolumeAlert(LOW_PAGES[1]!, [{ label: "120 min", count: 0, floor: 1 }], true);
  assert(
    followUp.includes(`\n${LANDING_HOST}/booking/${SUBMISSION_ID} (a lead marked eligible for the AI agent)\n`),
    `the Follow Up alert names the eligible variant on its link: ${followUp}`,
  );
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
  const some = pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 3, hostless: 0, pages });
  eq(some.state, "unrecorded", "any booking with no source in the lookback holds the floors back");
  assert(some.state === "unrecorded" && some.text.startsWith("Source not recorded on 3 of 40 bookings in the last 7 days"), `in those words (${some.state === "unrecorded" ? some.text : ""})`);
  const all = pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 40, hostless: 0, pages: pages.map((p) => ({ ...p, recorded: false })) });
  assert(all.state === "unrecorded" && all.text.startsWith("Source not recorded on 40 of 40 bookings"), "the pre #2072 state, every booking unsourced, says so");
  const none = pageSourceStatus({ lookbackDays: 7, realBookings: 0, unsourced: 0, hostless: 0, pages: pages.map((p) => ({ ...p, recorded: false })) });
  assert(none.state === "unmeasured" && /no real booking in the last 7 days/i.test(none.text), "no bookings at all is unmeasured, never recorded (L98)");
  eq(pageSourceStatus({ lookbackDays: 7, realBookings: 40, unsourced: 0, hostless: 0, pages }).state, "recorded", "only a lookback where every booking carried one shows floors");
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

/** The pilot sending Slate every Low lead: the pages are judged against their floors as written. */
const EVERY_LOW_LEAD: PilotSettings = { active: true, percent: 100, tiers: "1;2;3;4;5", lastModified: "2026-10-01T12:00:00.000Z" };

function harness(opts: {
  baselines?: Partial<Record<LowPageId, VolumeBaseline>>;
  rows?: SourceRow[];
  readThrows?: boolean;
  seen?: boolean | "throws";
  tierLow?: boolean | null;
  armed?: boolean;
  nowMs?: number;
  businessHours?: BusinessHoursConfig;
  /** The pilot settings Salesforce answers with, or "throws" for a read that failed. */
  pilot?: PilotSettings | "throws";
  heldOff?: Readonly<Partial<Record<LowPageId, HeldOffSlate>>>;
}) {
  // The pilot condition is kept apart from the pages' own keys, so every case about a
  // page reads its own keys and the pilot's cases read theirs.
  const calls = {
    reads: 0,
    seen: 0,
    sent: [] as { key: string; text: string }[],
    resolved: [] as { key: string; text: string }[],
    pilotReads: 0,
    pilotSent: [] as { key: string; ms: number; text: string }[],
    pilotCleared: [] as { key: string; text: string }[],
  };
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
      // Every Low lead on Slate leaves every floor as written, so the fixtures below
      // mean what they say; the pilot's own cases set the settings they are about.
      readPilot: async () => {
        calls.pilotReads++;
        const pilot = opts.pilot ?? EVERY_LOW_LEAD;
        if (pilot === "throws") throw new Error("salesforce read failed");
        return pilot;
      },
      ...(opts.heldOff ? { heldOff: opts.heldOff } : {}),
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
      notify: async (key, ms, text) => {
        if (key === PAGE_VOLUME_PILOT_UNKNOWN_KEY) calls.pilotSent.push({ key, ms, text });
        else calls.sent.push({ key, text });
      },
      resolveRecovered: async (recovered) => {
        for (const r of recovered) (r.key === PAGE_VOLUME_PILOT_UNKNOWN_KEY ? calls.pilotCleared : calls.resolved).push(r);
        return recovered.map((r) => r.key);
      },
    });
  return { calls, run };
}

const ago = (min: number, source: string | null): SourceRow => ({ createdMs: TUESDAY_2PM - min * MIN, source, hostless: false });
/** #2960: a booking made with no host page recorded (the standalone /book page, typed by hand). */
const agoHostless = (min: number, source: string | null): SourceRow => ({ ...ago(min, source), hostless: true });
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

// --- 3. the pilot switch: pages are judged only while Slate takes every Low lead ---
//
// Saturday 2026-10-03, 2:46pm: the alarm paged Income Verification for "0 in the last
// 120 min (expected at least 1, measured for Saturdays 2pm to 3pm)" while the page was
// booking. Those floors are cal.com's for every lead on the page, and the pilot sent
// Slate half of them. Thinning the floors to Slate's share (#3193) left no hour any
// page could be judged in, and a daily message saying so. Dan, 2026-10-08: page only
// when the pilot sends Slate every Low lead, read straight from Salesforce, and say
// nothing otherwise.
const SETTINGS = (over: Partial<PilotSettings>): PilotSettings => ({
  active: true,
  percent: 100,
  tiers: "1;2;3;4;5",
  lastModified: "2026-10-01T12:00:00.000Z",
  ...over,
});
{
  // The gate mirrors trypennie's `shouldUseSlate` (src/utils/booking.ts), which is what
  // actually sends a lead to Slate (L620): off unless active, Low's digit "1" must be
  // among the tiers, an empty percentage means 100, and a lead goes to Slate when its
  // bucket (0 to 99) is below the percentage.
  const cases: [string, PilotSettings | null, LowPilot][] = [
    ["every Low lead", SETTINGS({}), { state: "whole" }],
    ["an empty percentage keeps every pilot lead on Slate", SETTINGS({ percent: null }), { state: "whole" }],
    ["a percentage above 100 is still every lead", SETTINGS({ percent: 150 }), { state: "whole" }],
    ["a split", SETTINGS({ percent: 50 }), { state: "split", percent: 50 }],
    ["a 99% split still leaves some Low leads on cal.com", SETTINGS({ percent: 99 }), { state: "split", percent: 99 }],
    ["a 0% split sends Slate nothing", SETTINGS({ percent: 0 }), { state: "off" }],
    ["the pilot switched off", SETTINGS({ active: false }), { state: "off" }],
    ["an unset switch reads as off, as trypennie reads it", SETTINGS({ active: null }), { state: "off" }],
    ["Low not among the tiers", SETTINGS({ tiers: "2;3" }), { state: "off" }],
    ["no tiers at all", SETTINGS({ tiers: null }), { state: "off" }],
    ["tiers written with commas and spaces", SETTINGS({ tiers: " 2 , 1 " }), { state: "whole" }],
    ["a settings read that failed", null, { state: "unreadable" }],
  ];
  for (const [name, settings, want] of cases) eq(lowPilot(settings), want, `pilot gate: ${name}`);
  eq(PILOT_LOW_TIER_DIGIT, "1", "Low is the XBC's first digit 1, the digit trypennie compares");
}
{
  const SAT_246PM = DateTime.fromISO("2026-10-03T14:46", { zone: ZONE }).toMillis();
  const sat = (min: number, source: string): SourceRow => ({ createdMs: SAT_246PM - min * MIN, source, hostless: false });
  // Income Verification's last booking was at 12:44, two hours and two minutes before.
  const rows = [sat(122, "offerhub"), ...[15, 40, 70, 100].map((m) => sat(m, "booking")), sat(60, "booking-agent-eligible")];
  const at = (pilot: PilotSettings) => harness({ nowMs: SAT_246PM, rows, pilot, baselines: { ...MEASURED_PAGE_BASELINES } });

  // Reproduce first (L681): with Slate taking every lead, the shipped floors page
  // exactly as production did, so the whole page's floors are the ones judged.
  const whole = at(SETTINGS({}));
  const wholeOut = await whole.run();
  const paged = whole.calls.sent.find((s) => s.key === pageVolumeAlertKey("income-verification"));
  assert(
    paged !== undefined && paged.text.includes("0 in the last 120 min (expected at least 1, measured for Saturdays 2pm to 3pm)"),
    "control: at 100% the 2:46pm page fires against the whole page's floors",
  );
  assert(wholeOut.status === "checked", "and the step judged the pages");

  // The same tick during a 50% split says nothing at all.
  const split = at(SETTINGS({ percent: 50 }));
  const out = await split.run();
  eq(out, { status: "not-judged", pilot: { state: "split", percent: 50 } }, "during a split the step stands down");
  eq(split.calls.reads + split.calls.seen, 0, "reading no bookings");
  eq(split.calls.sent.length + split.calls.pilotSent.length, 0, "and sending nothing to Slack");
  eq(split.calls.resolved.length, 0, "and clearing nothing about any page");
}
{
  // Every state but a split behaves the same way when it stands down: no booking read,
  // no page, no message. Only an unreadable switch says anything.
  for (const [name, settings] of [
    ["off", SETTINGS({ active: false })],
    ["split", SETTINGS({ percent: 50 })],
    ["Low not in the pilot", SETTINGS({ tiers: "2" })],
  ] as const) {
    const h = harness({ rows: [], pilot: settings, baselines: Object.fromEntries(LOW_PAGES.map((p) => [p.id, flat(5, 20)])) });
    const out = await h.run();
    eq(out.status, "not-judged", `${name}: not judged`);
    eq(h.calls.sent.length + h.calls.pilotSent.length + h.calls.reads, 0, `${name}: silent, and reads no bookings`);
    // A switch that was READ ends an earlier "could not read it" message.
    eq(h.calls.pilotCleared.map((r) => r.key), [PAGE_VOLUME_PILOT_UNKNOWN_KEY], `${name}: a read switch clears the unreadable condition`);
    assert(/^Per page Low alerts now follow the pilot settings in Salesforce/.test(h.calls.pilotCleared[0]!.text), `${name}: in words that say so (${h.calls.pilotCleared[0]?.text})`);
  }
  // Control in the same fixture (L159): at 100% the same silent tick pages every page.
  const control = harness({ rows: [], pilot: SETTINGS({}), baselines: Object.fromEntries(LOW_PAGES.map((p) => [p.id, flat(5, 20)])) });
  await control.run();
  eq(control.calls.sent.length, 3, "control: at 100% the same silent tick pages every page");
  eq(control.calls.pilotCleared.map((r) => r.key), [PAGE_VOLUME_PILOT_UNKNOWN_KEY], "and a judged tick clears the unreadable condition too");
  assert(/^Per page Low alerts are on/.test(control.calls.pilotCleared[0]!.text), `saying they are on (${control.calls.pilotCleared[0]?.text})`);
  eq(control.calls.pilotReads, 1, "the switch is read once per tick, however many pages are judged");
}
{
  // An unreadable switch is not a split and not 100%: it stands down, and says so once,
  // with how to look at the settings.
  const h = harness({ rows: [], pilot: "throws", baselines: Object.fromEntries(LOW_PAGES.map((p) => [p.id, flat(5, 20)])) });
  const out = await h.run();
  eq(out, { status: "not-judged", pilot: { state: "unreadable" } }, "an unreadable switch stands the step down");
  eq(h.calls.reads + h.calls.seen + h.calls.sent.length + h.calls.resolved.length + h.calls.pilotCleared.length, 0, "reading, paging and clearing nothing");
  eq(h.calls.pilotSent.map((s) => s.key), [PAGE_VOLUME_PILOT_UNKNOWN_KEY], "and raises the one condition");
  eq(h.calls.pilotSent[0]?.ms, PAGE_VOLUME_PILOT_UNKNOWN_COOLDOWN_MS, "at its own cooldown");
  const text = h.calls.pilotSent[0]?.text ?? "";
  for (const needle of ["Website Configuration (trypennie.com)", "Slate Pilot Active", "Slate Pilot Percent", "Slate Pilot Tiers", "A full Low outage still alerts"]) {
    assert(text.includes(needle), `the message says how to look: ${needle} (${text})`);
  }
  assert(!/[\u2014\u2013]/.test(text) && !/undefined|NaN|null/.test(text), "with no dash and no leaked value");
  eq(PAGE_VOLUME_PILOT_UNKNOWN_COOLDOWN_MS, 24 * 60 * MIN, "repeated at most daily while it lasts");

  const disarmed = harness({ rows: [], pilot: "throws", armed: false });
  await disarmed.run();
  eq(disarmed.calls.pilotSent.length, 0, "a disarmed alarm pages nobody anyway, so it raises nothing");

  // Outside the org's hours there is nothing to judge, so the switch is not even read.
  const shut = harness({ nowMs: SUNDAY_2PM, pilot: "throws" });
  eq((await shut.run()).status, "outside-hours", "outside hours reads as outside hours");
  eq(shut.calls.pilotReads + shut.calls.pilotSent.length + shut.calls.pilotCleared.length, 0, "and neither reads the switch nor says anything about it");

  // A tick that judged and then failed to read bookings cleared nothing.
  const broken = harness({ rows: [], pilot: SETTINGS({}), readThrows: true, baselines: Object.fromEntries(LOW_PAGES.map((p) => [p.id, flat(5, 20)])) });
  let threw = false;
  await broken.run().catch(() => (threw = true));
  assert(threw && broken.calls.pilotCleared.length + broken.calls.resolved.length === 0, "a bookings read that threw clears nothing");

}
{
  // The words the admin page shows beside the table, from the same gate.
  eq(pilotPageLine({ state: "whole" }), null, "at 100% the pages are judged and nothing needs saying");
  eq(pilotPageLine({ state: "split", percent: 50 }), "Per page Low alerts are off while the pilot sends Slate 50% of Low leads. They turn on at 100%.", "a split");
  eq(pilotPageLine({ state: "off" }), "Per page Low alerts are off while the pilot sends Slate no Low leads.", "off");
  assert(/could not be read/.test(pilotPageLine({ state: "unreadable" }) ?? "") && /Website Configuration \(trypennie\.com\)/.test(pilotPageLine({ state: "unreadable" }) ?? ""), "unreadable says where to look");
}

// --- 3. #2878's held off path, driven with a sample entry while the switch is empty ---
{
  // A page Slate does not carry is never judged, paged or cleared, however high its
  // floors and however silent it is.
  const sample = { "income-verification": { reason: "come from a page not wired to Slate", issue: 1 } } as const;
  const h = harness({ rows: HEALTHY_ROWS, baselines: { "income-verification": flat(5, 20) }, seen: false, heldOff: sample });
  const out = await h.run();
  const judged = out.status === "checked" ? out.pages.map((p) => p.id) : [];
  eq(judged, LOW_PAGES.slice(1).map((p) => p.id), "only the pages Slate carries are judged");
  assert(!h.calls.sent.some((s) => s.key === pageVolumeAlertKey("income-verification")), "a held off page is never paged, not even as a page never seen");
  assert(!h.calls.resolved.some((r) => r.key === pageVolumeAlertKey("income-verification")), "and never cleared, since it measured nothing");
  eq(h.calls.seen, 0, "and no lookup is spent on it");
  // Control in the SAME fixture (L159): the carried pages are judged healthy and clear.
  eq(
    h.calls.resolved.map((r) => r.key).sort(),
    LOW_PAGES.slice(1).map((p) => pageVolumeAlertKey(p.id)).sort(),
    "control: the carried pages clear",
  );
  // Control: the same fixture with nothing held off pages Income Verification.
  const notHeld = harness({ rows: HEALTHY_ROWS, baselines: { "income-verification": flat(5, 20) }, seen: false });
  await notHeld.run();
  assert(notHeld.calls.sent.some((s) => s.key === pageVolumeAlertKey("income-verification")), "control: not held off, the same silence pages");

  // An hour in which ONLY the held off page could be judged reads nothing at all.
  const only = harness({
    baselines: { ...Object.fromEntries(LOW_PAGES.map((p) => [p.id, flat(0, 0)])), "income-verification": flat(5, 20) },
    rows: [],
    heldOff: sample,
  });
  const onlyOut = await only.run();
  eq(only.calls.reads, 0, "no read for a page that is not judged");
  assert(onlyOut.status === "checked" && onlyOut.pages.every((p) => p.verdict === "unmeasured-hour"), "the carried pages report unmeasured");
  eq(only.calls.sent.length + only.calls.resolved.length, 0, "and nothing is paged or cleared");
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
  assert(
    text.startsWith("Bookings from the Completed Application Review Follow Up page are low") &&
      text.includes(`/booking/${SUBMISSION_ID} (a lead marked eligible for the AI agent)`),
    "the page names the page and its address",
  );
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
    assert(!isUnsourced({ source: s, hostless: false }), `${s} is not an unsourced booking`);
    assert(!isPageTraffic(s), `${s} is not page traffic`);
  }
  // #4200: a coordinator booking was placed by a person on the phone with the
  // customer, not made on any landing page, so it can no more excuse a dark page than
  // an API call can.
  assert(!isUnsourced({ source: "coordinator", hostless: false }), "coordinator is not an unsourced booking");
  assert(!isPageTraffic("coordinator"), "coordinator is not page traffic");
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
  // #2960 (Dan, 2026-10-01): a booking made with NO host page recorded, and no
  // source, was made by hand on the standalone booker, never by a landing page. It
  // does not count toward the unsourced share that holds a page, and it is not in
  // the total that share is quoted against. It is still counted, on its own.
  for (const source of ["not-given", null]) {
    assert(!isUnsourced({ source, hostless: true }), `a hostless ${source ?? "null"} booking is not unsourced`);
    assert(isHostlessUnsourced({ source, hostless: true }), `it is a hostless unsourced booking`);
    assert(isUnsourced({ source, hostless: false }), `the same booking framed by a page is unsourced`);
    assert(!isHostlessUnsourced({ source, hostless: false }), `and not hostless`);
  }
  // A hostless booking that DID name a page is that page's: only the missing source
  // makes it unattributable, so only then is it set aside.
  assert(!isHostlessUnsourced({ source: "booking", hostless: true }), "a hostless booking naming a page is not set aside");
  assert(!isHostlessUnsourced({ source: "api-regal", hostless: true }), "nor is an API booking, which is not page traffic at all");

  const quietRows = HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible");
  const byHand = harness({ rows: [...quietRows, agoHostless(10, "not-given"), agoHostless(20, null), agoHostless(40, "not-given")] });
  const byHandOut = await byHand.run();
  eq(byHand.calls.sent.map((s) => s.key), [pageVolumeAlertKey("application-review-follow-up")], "hand made bookings with no host page do not hold a quiet page: it pages");
  assert(
    byHandOut.status === "checked" &&
      byHandOut.sources.unsourced === 0 &&
      byHandOut.sources.hostless === 3 &&
      byHandOut.sources.total === quietRows.length,
    `and they are counted on their own line, out of both the unsourced count and the total (${JSON.stringify(byHandOut.status === "checked" ? byHandOut.sources : null)})`,
  );
  // The case the decision must not break: a PAGE booking (framed by a host) that lost
  // its source still holds the page, because it may be that page's missing booking.
  const framed = harness({ rows: [...quietRows, ago(10, "not-given"), ago(20, null), ago(40, "not-given")] });
  const framedOut = await framed.run();
  eq(framed.calls.sent.length, 0, "control: the same three bookings framed by a page still hold it");
  assert(
    framedOut.status === "checked" && verdictOf(framedOut.pages, "application-review-follow-up").verdict === "source-unrecorded" && framedOut.sources.hostless === 0,
    "and read as source unrecorded, with nothing set aside",
  );

  // The status surfaces: set aside bookings are said on their own line in every state.
  const pages = LOW_PAGES.map((p) => ({ id: p.id, name: p.name, recorded: true }));
  const clean = pageSourceStatus({ lookbackDays: 7, realBookings: 193, unsourced: 0, hostless: 4, pages });
  assert(clean.state === "recorded", "hand made bookings alone leave the sources recorded, so the floors stand");
  assert(
    clean.state === "recorded" && clean.note !== null && /^4 bookings in the last 7 days were made with no host page/.test(clean.note),
    `and the status still says how many were set aside (${clean.state === "recorded" ? clean.note : ""})`,
  );
  const plain = pageSourceStatus({ lookbackDays: 7, realBookings: 193, unsourced: 0, hostless: 0, pages });
  assert(plain.state === "recorded" && plain.note === null, "no note when nothing was set aside");
  const mixed = pageSourceStatus({ lookbackDays: 7, realBookings: 193, unsourced: 1, hostless: 4, pages });
  assert(
    mixed.state === "unrecorded" && mixed.text.startsWith("Source not recorded on 1 of 193 bookings") && /4 bookings in the last 7 days were made with no host page/.test(mixed.text),
    `a page booking without a source still holds, and the set aside count rides along (${mixed.state === "unrecorded" ? mixed.text : ""})`,
  );
  const SET_ASIDE_LINE = /^[0-9]+ bookings in the last 7 days were made with no host page/;
  const onlyByHand = pageSourceStatus({ lookbackDays: 7, realBookings: 0, unsourced: 0, hostless: 2, pages });
  assert(
    onlyByHand.state === "unmeasured" && /2 bookings in the last 7 days were made with no host page/.test(onlyByHand.text),
    "a lookback holding only hand made bookings is unmeasured, and says what it did hold",
  );
  // Every state hands the line out as `note`, from this one builder, and a state with
  // text ends with it, so a surface writing its own words for a state can append it.
  for (const st of [clean, mixed, onlyByHand]) {
    assert(st.note !== null && SET_ASIDE_LINE.test(st.note), `${st.state}: note carries the set aside line`);
    if (st.state !== "recorded") assert(st.text.endsWith(st.note!), `${st.state}: and its text ends with it`);
  }
  eq(pageSourceStatus(null).note, null, "an unreadable measurement sets nothing aside");
  eq(hostlessNotCounted(1, "7 days"), "1 booking in the last 7 days was made with no host page and carried no source, so it is not counted toward that share.", "one booking reads in the singular");
}
{
  // Rows at or after now, or before the long window, are outside every window.
  const h = harness({ rows: [...HEALTHY_ROWS.filter((r) => r.source !== "booking-agent-eligible"), { createdMs: TUESDAY_2PM, source: "booking-agent-eligible", hostless: false }, ago(121, "booking-agent-eligible")] });
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
