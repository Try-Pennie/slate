// Fit the low booking volume floors to real traffic. Run:
//   pnpm measure:volume-floors
//
// WHY IT EXISTS (#1956). The floors the low volume alarm judges against were two
// hand typed numbers, one for every hour of the week, and nothing had ever measured
// either. This reads the bookings cal.com actually took, per landing page, and fits
// a floor per weekday and hour to the traffic Slate carries (FLOOR_SCOPE in
// scripts/lib/volume-floor-scope.ts, derived from LOW_PAGES_ON_SLATE in
// src/lib/monitor/page-volume.ts; widening the pilot to another Low page is an edit
// there followed by REFIT=1, #2878).
//
// WHAT IT WRITES, both committed:
//   scripts/fixtures/calcom-low-bookings.json   bookings per 5 minute bucket per page
//                                               (counts only, nothing about any lead)
//   src/lib/monitor/volume-baseline.ts          the fitted floors the monitor reads
//   src/lib/monitor/page-volume-baseline.ts     the same fit per Low page (#2738)
// scripts/test-volume-floors.ts and scripts/test-page-volume.ts re-derive the
// floors from the measurement and fail when they differ, and replay the armed
// alarms against it.
//
// WHAT COUNTS AS A BOOKING. A routing form response whose `routedToBookingUid` is
// set, placed at the moment the response was recorded, which is within minutes of
// the booking being created. cal.com's own bookings listing carries no landing page,
// and the page is exactly the dimension the first flip is cut along.
//
// THE ORG'S CLOSED DAYS (#2764). A day `business_hours_exceptions` records as shut is
// a day the alarms never judge, so the fit leaves it out, and the dates are recorded
// in the fixture beside the counts so a refit leaves out the same ones. They are read
// through `loadBusinessHoursExceptions`, the loader the availability gate uses, which
// needs the Supabase secret key (.env.local, or ENV_FILE from a worktree). A holiday
// recorded AFTER a measurement is picked up with RECORD_CLOSED_DAYS=1, which re-reads
// them for the committed span and refits without reading cal.com.
//
// THE OTHER TIERS (#2888). MEASURE_TIER picks the debt tier, Low (1) when unset, so
// every run above is unchanged. Any other tier is measured WHOLE, every form cal.com
// booked it through, since no alarm reads per page floors for it, and writes:
//   scripts/fixtures/calcom-tier-<tier>-bookings.json   that tier's counts, alone
//   src/lib/monitor/volume-baseline-tiers.ts             every measured tier's floors,
//                                                        rendered from every such file
// and never touches Low's files. A Low run re-renders that module too, since it holds
// Low's whole tier fit beside the others (#2893). None of them is applied as measured:
// each is thinned to the share of its tier Slate carries (carried-share.ts, Dan
// 2026-09-29). scripts/test-volume-tier-anchors.ts holds the module to the files. REFIT=1 and RECORD_CLOSED_DAYS=1 work the same
// way per tier. A tier so thin that no judged hour carries a floor is refused rather
// than written, in every mode, since it could never hold a floor up and would still
// read as a real measurement.
//
// It talks to cal.com, so it is deliberately not named `test-*.ts`.
//
// Env:
//   MEASURE_TIER     the debt tier digit, 1 (Low, the default) to 5 (Ultra High)
//   CALCOM_API_KEY   required
//   CALCOM_ORG_ID    default 19474
//   MEASURE_DAYS     how far back to read (default 63, nine whole weeks)
//   MEASURE_END      where the span ends, an instant with its zone (default now). Since
//                    the 50/50 split on every tier (2026-10-01 15:46 UTC) a span ending
//                    later counts about half of each tier, so pin it before the split.
//   MEASURE_ZONE     the zone weekday and hour are judged in (default America/New_York)
//   MEASURE_PACE_MS  pacing between pages (default 550, measured in #2240)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFiles, envOr } from "./smoke-env.ts";
import {
  PACE_REFUSAL,
  calcomGetter,
  measureEndOrRefusal,
  paceMsOrNull,
  readRoutingResponses,
  tierOf,
} from "./lib/calcom-routing-responses.ts";
import {
  FLOOR_SCOPE,
  TIER_BASELINES_PATH,
  buildFixture,
  baselineFromFixture,
  judgedHourCoverage,
  measureTargetFor,
  pageBaselinesFromFixture,
  readTierFixtures,
  renderBaselineModule,
  renderPageBaselineModule,
  renderTierBaselineModule,
  thinAnchorRefusal,
  tierBaselinesFromFixtures,
  wholeTierScope,
  OFFLINE_OPEN_WEEK,
  type FloorScope,
  type VolumeFixture,
} from "./lib/volume-floor-scope.ts";
import { LOW_PAGES_ON_SLATE, pageCoverage, pagesNotOnSlateLines } from "../src/lib/monitor/page-volume.ts";
import { SERIES_BUCKET_MINUTES, WEEKDAY_NAMES, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { tierLabel } from "../src/lib/monitor/volume-tiers.ts";

// Which tier, before anything else: a refit or a closed day recording for the wrong
// tier would rewrite a committed measurement as surely as a live run would.
const TARGET_READ = measureTargetFor(process.env.MEASURE_TIER);
if (!TARGET_READ.ok) {
  console.error(TARGET_READ.refusal);
  process.exit(1);
}
const TARGET = TARGET_READ.target;

const FIXTURE_PATH = TARGET.fixturePath;
const BASELINE_PATH = "src/lib/monitor/volume-baseline.ts";
const PAGE_BASELINE_PATH = "src/lib/monitor/page-volume-baseline.ts";

/** Low keeps FLOOR_SCOPE; every other tier is fitted whole. */
const scopeOf = (fixture: VolumeFixture): FloorScope => (TARGET.low ? FLOOR_SCOPE : wholeTierScope(fixture));

/**
 * Writes the measurement and its floors, and is the ONLY place any mode writes, so
 * the too thin refusal below guards the live read, REFIT=1 and RECORD_CLOSED_DAYS=1
 * alike: a refit or a recorded holiday can thin a fit as surely as a read can. A
 * tier beside Low whose floors are zero at every judged hour is reported and exits
 * 6 with nothing written, since committed it would read as a measured floor and
 * could never hold anything up. Low writes its own module; any other tier writes
 * its own counts and re-renders the tier module from EVERY committed tier
 * measurement, so measuring one tier never drops another's saved measurement.
 */
function writeMeasurement(fixture: VolumeFixture, baseline: VolumeBaseline): void {
  const thin = TARGET.low ? null : thinAnchorRefusal(baseline, OFFLINE_OPEN_WEEK);
  if (thin) {
    report(fixture, baseline);
    console.error(thin);
    process.exit(6);
  }
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture) + "\n");
  if (TARGET.low) writeFileSync(BASELINE_PATH, renderBaselineModule(baseline));
  // Every tier's whole tier fit, Low's included since #2893, so a Low run re-renders
  // the tier module too: its whole tier fit comes from the file just written.
  const all = { ...readTierFixtures(), [TARGET.tier]: fixture };
  writeFileSync(TIER_BASELINES_PATH, renderTierBaselineModule(tierBaselinesFromFixtures(all)));
}

/** What the floors cover: Low's per page floors, or how much of the week a whole tier's measurement carries a floor. */
function writeAfter(fixture: VolumeFixture, baseline: VolumeBaseline): void {
  if (TARGET.low) {
    writePages(fixture);
    return;
  }
  const { withFloor, judged } = judgedHourCoverage(baseline, OFFLINE_OPEN_WEEK);
  console.log(`\n${tierLabel(TARGET.tier)}: ${withFloor} of the ${judged} hours the alarm judges carry a floor above zero.`);
}

/** The committed measurement for this tier, refused by name when there is none to refit. */
function readCommitted(): VolumeFixture {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`FAILED (no-measurement): ${FIXTURE_PATH} does not exist, so there is nothing to refit; measure the tier first`);
    process.exit(5);
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VolumeFixture;
}

/** Writes each page's floors and says, per page, how much of its week they can judge (#2738). */
function writePages(fixture: VolumeFixture): void {
  const pages = pageBaselinesFromFixture(fixture);
  writeFileSync(PAGE_BASELINE_PATH, renderPageBaselineModule(pages));
  console.log("\nPer page floors:");
  for (const page of LOW_PAGES_ON_SLATE) console.log(`  ${pageCoverage(page, pages[page.id], OFFLINE_OPEN_WEEK).text}`);
  // #2878: every Low page's floors are written, and a page held off Slate is said
  // to be held off rather than listed as though its alarm were judging it.
  for (const line of pagesNotOnSlateLines()) console.log(`  ${line}`);
}

function report(fixture: VolumeFixture, baseline: VolumeBaseline): void {
  for (const [name, counts] of Object.entries(fixture.forms)) {
    console.log(`  ${counts.reduce((s, n) => s + n, 0)} bookings: ${name}`);
  }
  console.log(
    `Fitted to ${baseline.bookings} bookings, ${baseline.tierShare === null ? "the whole tier" : `${Math.round(baseline.tierShare * 100)}% of the tier`}.`,
  );
  console.log(`\nFloors per hour (${baseline.zone}), shown as 30 minute / 120 minute:`);
  console.log(`           ${Array.from({ length: 24 }, (_, h) => String(h).padStart(5)).join("")}`);
  baseline.cells.forEach((day, i) => {
    console.log(`${WEEKDAY_NAMES[i]!.padEnd(10)} ${day.map((c) => `${c.floor30}/${c.floor120}`.padStart(5)).join("")}`);
  });
}

/**
 * The closed days from `fromIsoDate` onward, through the loader the availability gate
 * uses (L41). Imported only once the env files are loaded, because the admin client
 * reads its key when it is built. A failed read throws: a fit with a holiday left IN
 * is the defect this exists to prevent, so it is never written on a guess.
 */
async function readClosedDates(fromIsoDate: string): Promise<string[]> {
  const { loadBusinessHoursExceptions } = await import("@/lib/booking/business-hours-load");
  const { closedExceptionDates } = await import("@/lib/booking/business-hours");
  return closedExceptionDates(await loadBusinessHoursExceptions(fromIsoDate));
}

// RECORD_CLOSED_DAYS=1 re-reads the org's closed days for the COMMITTED measurement's
// span and refits, without reading cal.com: a holiday entered after the measurement.
if (process.env.RECORD_CLOSED_DAYS === "1") {
  loadEnvFiles([".env.local", ".dev.vars", ...(process.env.ENV_FILE ? [process.env.ENV_FILE] : [])]);
  const committed = readCommitted();
  const span = baselineFromFixture({ ...committed, closedDates: [] }, scopeOf(committed));
  const read = await readClosedDates(span.fromDate).catch((e: Error) => {
    console.error(`FAILED (closed-days-unreadable): ${e.message}; nothing was written`);
    process.exit(4);
  });
  const fixture: VolumeFixture = {
    ...committed,
    closedDates: read.filter((d) => d >= span.fromDate && d <= span.toDate),
  };
  const baseline = baselineFromFixture(fixture, scopeOf(fixture));
  writeMeasurement(fixture, baseline);
  console.log(`Closed days in ${span.fromDate} to ${span.toDate}: ${fixture.closedDates.join(", ") || "none"}. Nothing was read from cal.com.`);
  report(fixture, baseline);
  writeAfter(fixture, baseline);
  process.exit(0);
}

// REFIT=1 re-fits the floors from the COMMITTED measurement without reading cal.com,
// which is what a change to FLOOR_SCOPE or to the fit itself needs.
if (process.env.REFIT === "1") {
  const fixture = readCommitted();
  const baseline = baselineFromFixture(fixture, scopeOf(fixture));
  writeMeasurement(fixture, baseline);
  console.log(`Re-fitted from the measurement taken ${baseline.measuredOn}; nothing was read from cal.com.`);
  report(fixture, baseline);
  writeAfter(fixture, baseline);
  process.exit(0);
}

// ENV_FILE lets a run from an agent worktree read the main checkout's .env.local,
// which a worktree does not have, without the key passing through a command line.
loadEnvFiles([".env.local", ".dev.vars", ...(process.env.ENV_FILE ? [process.env.ENV_FILE] : [])]);

const KEY = process.env.CALCOM_API_KEY?.trim() ?? "";
if (!KEY) {
  console.error("FAILED (not-configured): CALCOM_API_KEY is needed here; nothing was read");
  process.exit(1);
}

const ORG = envOr(process.env.CALCOM_ORG_ID, "19474");
const DAYS = Number(envOr(process.env.MEASURE_DAYS, "63"));
const ZONE = envOr(process.env.MEASURE_ZONE, "America/New_York");
const PACE_MS = paceMsOrNull(envOr(process.env.MEASURE_PACE_MS, "550"));
if (!Number.isInteger(DAYS) || DAYS < 14) {
  // Two weeks is two samples per weekday and hour, which is no distribution at all.
  console.error("FAILED (bad-input): MEASURE_DAYS must be a whole number of at least 14");
  process.exit(1);
}
if (PACE_MS === null) {
  console.error(PACE_REFUSAL);
  process.exit(1);
}
const END = measureEndOrRefusal(process.env.MEASURE_END ?? "", Date.now());
if (!END.ok) {
  console.error(END.refusal);
  process.exit(1);
}

const calGet = calcomGetter(KEY);

const per = SERIES_BUCKET_MINUTES * 60_000;
const endMs = Math.floor(END.endMs / per) * per;
const startMs = endMs - DAYS * 86_400_000;
const read = await readRoutingResponses({
  get: calGet,
  org: ORG,
  fromIso: new Date(startMs).toISOString(),
  paceMs: PACE_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
if (!read.ok) {
  console.error(
    `FAILED (calcom-unreadable): cal.com answered ${read.status}` +
      (read.formName ? ` for "${read.formName}"` : " for the org's routing forms") +
      ", so nothing was written. A partial read would fit floors to part of the traffic.",
  );
  process.exit(2);
}

const closedDates = await readClosedDates(new Date(startMs).toISOString().slice(0, 10)).catch((e: Error) => {
  console.error(`FAILED (closed-days-unreadable): ${e.message}; nothing was written`);
  process.exit(4);
});
const fixture = buildFixture({
  closedDates,
  rows: read.rows.map((r) => ({ ...r, tier: tierOf(r.code) })),
  tier: TARGET.tier,
  startMs,
  endMs,
  bucketMinutes: SERIES_BUCKET_MINUTES,
  zone: ZONE,
  measuredOn: new Date(endMs).toISOString().slice(0, 10),
  formNames: [],
});
if (!TARGET.low && Object.keys(fixture.forms).length === 0) {
  console.error(
    `FAILED (tier-unmeasured): cal.com took no ${tierLabel(TARGET.tier)} bookings in ${DAYS} days, so there is nothing to fit; nothing was written`,
  );
  process.exit(3);
}
const missing = TARGET.low ? FLOOR_SCOPE.forms.filter((f) => !fixture.forms[f]) : [];
if (missing.length > 0) {
  console.error(
    `FAILED (scope-unmeasured): no bookings for ${missing.map((m) => `"${m}"`).join(", ")}. ` +
      "A renamed form is the likely cause; update FLOOR_SCOPE rather than fitting floors to nothing.",
  );
  process.exit(3);
}

const baseline = baselineFromFixture(fixture, scopeOf(fixture));
console.log(
  `Read ${read.rows.length} routing form responses over ${DAYS} days (${baseline.fromDate} to ${baseline.toDate}).`,
);
writeMeasurement(fixture, baseline);
report(fixture, baseline);
writeAfter(fixture, baseline);
