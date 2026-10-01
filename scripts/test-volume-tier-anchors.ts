// The whole tier cal.com measurements of every tier (#2888, #2893). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-tier-anchors.ts
//
// What this pins:
// - which tier `pnpm measure:volume-floors` measures is read from MEASURE_TIER, Low
//   when it is unset, and anything that is not a debt tier is refused by name;
// - every committed tier measurement re-derives exactly the committed floors module,
//   the same parity scripts/test-volume-floors.ts holds for Low (L422);
// - each measurement is filed under the tier it actually counted (L70), and none is
//   applied as measured: each is listed in TIER_MEASUREMENTS to be thinned to the
//   share of its tier Slate carries (#2893), while TIER_ANCHORS, the anchors before
//   any share is measured, stays Low's two page fit alone, the state that was armed;
// - a measurement fitted to so little traffic that no judged hour carries a floor is
//   refused rather than saved.
import { existsSync, readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { LOW_TIER, TIER_ANCHORS, TIER_MEASUREMENTS, VOLUME_TIERS, tierLabel, type VolumeTier } from "../src/lib/monitor/volume-tiers.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { WHOLE_TIER_MEASUREMENTS } from "../src/lib/monitor/volume-baseline-tiers.ts";
import { fitFloorCells, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { headOf, replayLowVolume, withGap } from "./lib/volume-floor-replay.ts";
import {
  FLOOR_SCOPE,
  LOW_FIXTURE_PATH,
  OFFLINE_OPEN_WEEK,
  TIER_BASELINES_PATH,
  baselineFromFixture,
  measureTargetFor,
  offlineHoursFor,
  readTierFixtures,
  renderTierBaselineModule,
  scopedSeries,
  thinAnchorRefusal,
  tierBaselinesFromFixtures,
  tierFixturePath,
  wholeTierScope,
  type VolumeFixture,
} from "./lib/volume-floor-scope.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const OTHERS = VOLUME_TIERS.filter((t) => t !== LOW_TIER);

// --- which tier a run measures ---
{
  for (const raw of [undefined, "", "  "]) {
    const t = measureTargetFor(raw);
    assert(t.ok && t.target.tier === LOW_TIER && t.target.low, `an unset MEASURE_TIER (${JSON.stringify(raw)}) measures Low, as the command always has`);
    if (t.ok) eq(t.target.fixturePath, LOW_FIXTURE_PATH, "into Low's own committed measurement");
  }
  for (const tier of OTHERS) {
    const t = measureTargetFor(tier);
    assert(t.ok && t.target.tier === tier && !t.target.low, `MEASURE_TIER=${tier} measures ${tierLabel(tier)}`);
    if (t.ok) eq(t.target.fixturePath, `scripts/fixtures/calcom-tier-${tier}-bookings.json`, "into its own committed measurement");
  }
  eq(measureTargetFor("1").ok && measureTargetFor("1"), measureTargetFor(""), "MEASURE_TIER=1 is the same run as leaving it unset");
  eq(new Set(VOLUME_TIERS.map(tierFixturePath)).size, VOLUME_TIERS.length, "every tier writes its own measurement, never another's");
  for (const bad of ["0", "6", "9", "1%", "low", "Low", "2.0", "3,4", "abc", "-1"]) {
    const t = measureTargetFor(bad);
    assert(!t.ok, `MEASURE_TIER=${JSON.stringify(bad)} is refused`);
    if (!t.ok) {
      assert(t.refusal.startsWith("FAILED (bad-input): MEASURE_TIER"), `and the refusal names the setting (${t.refusal})`);
      for (const tier of VOLUME_TIERS) {
        assert(t.refusal.includes(`${tier} (${tierLabel(tier)})`), `and lists ${tierLabel(tier)} among the tiers it accepts`);
      }
    }
  }
}

// --- the whole tier scope ---
const synthetic = (tier: string, forms: Record<string, number[]>): VolumeFixture => ({
  source: "calcom",
  measuredOn: "2026-09-29",
  zone: "America/New_York",
  tier,
  startMs: Date.UTC(2026, 6, 27, 4),
  bucketMinutes: 5,
  forms,
  closedDates: [],
});
{
  const f = synthetic("3", { A: [1, 0, 2], B: [0, 3, 0] });
  const scope = wholeTierScope(f);
  eq(scope.tier, "3", "a tier beside Low is scoped to its own tier");
  eq(scope.forms, ["A", "B"], "and to every form it booked through, since no page scope exists for it");
  assert(scope.label.includes("High"), `and says whose traffic it is (${scope.label})`);
  const b = baselineFromFixture(f, scope);
  eq(b.tierShare, null, "so its floors are the whole tier's");
  eq(b.bookings, 6, "fitted to every booking the tier took");
  // #2893 reversed "Low is never given the whole tier scope": Low's whole tier fit is
  // the measurement thinned once Slate carries more of Low than its two pages.
  eq(wholeTierScope(synthetic("1", { A: [1], B: [2] })).forms, ["A", "B"], "Low's whole tier scope is every form it booked through");
  let refused = "";
  try {
    tierBaselinesFromFixtures({ "2": synthetic("3", { A: [1] }) });
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(refused.includes("tier 3") && refused.includes("tier 2"), `a measurement filed under another tier is refused by name (${refused})`);
}

// --- an anchor too thin to judge anything is refused ---
{
  const flat = (floor120: number): VolumeBaseline => ({
    ...MEASURED_VOLUME_BASELINE,
    cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (): FloorCell => ({ floor30: 0, floor120, typical120: floor120 }))),
  });
  const thin = thinAnchorRefusal(flat(0), OFFLINE_OPEN_WEEK);
  assert(thin !== null && thin.startsWith("FAILED (too-thin)"), `floors of zero at every judged hour are refused (${thin})`);
  eq(thinAnchorRefusal(flat(2), OFFLINE_OPEN_WEEK), null, "control: a floor at the judged hours is accepted");
  const sundayOnly = flat(0);
  sundayOnly.cells[6] = sundayOnly.cells[6]!.map((c) => ({ ...c, floor120: 5 }));
  assert(thinAnchorRefusal(sundayOnly, OFFLINE_OPEN_WEEK) !== null, "a floor only on Sunday, which is never judged, is still too thin");
  eq(thinAnchorRefusal(MEASURED_VOLUME_BASELINE, OFFLINE_OPEN_WEEK), null, "control: Low's committed anchor is not thin");
}

// --- the committed tier measurements are the committed floors ---
const fixtures = readTierFixtures();
{
  const derived = tierBaselinesFromFixtures(fixtures);
  // assert rather than eq, so a failure names the fix instead of printing two
  // copies of a long module (L445).
  assert(
    renderTierBaselineModule(derived) === readFileSync(TIER_BASELINES_PATH, "utf8"),
    `${TIER_BASELINES_PATH} is exactly what the committed tier measurements fit to (run MEASURE_TIER=<tier> REFIT=1 pnpm measure:volume-floors)`,
  );
  assert(JSON.stringify(WHOLE_TIER_MEASUREMENTS) === JSON.stringify(derived), "and the module evaluates to those baselines");
  eq(Object.keys(WHOLE_TIER_MEASUREMENTS).sort(), Object.keys(fixtures).sort(), "one baseline per committed measurement, no more and no fewer");
  for (const tier of OTHERS) {
    const f = fixtures[tier];
    if (!f) {
      assert(!existsSync(tierFixturePath(tier)), `tier ${tier} has no measurement file, so it has no anchor`);
      continue;
    }
    eq(f.tier, tier, `${tierFixturePath(tier)} counted ${tierLabel(tier)}, the tier its file is named for`);
    const b = WHOLE_TIER_MEASUREMENTS[tier]!;
    eq(b.tierShare, null, `${tierLabel(tier)}'s floors are the whole tier's`);
    assert(b.bookings > 0, `${tierLabel(tier)} was fitted to real bookings (${b.bookings})`);
    eq(thinAnchorRefusal(b, OFFLINE_OPEN_WEEK), null, `${tierLabel(tier)}'s anchor carries a floor at some judged hour`);
    eq(b.cells.length, 7, `${tierLabel(tier)} has seven weekdays`);
    assert(b.cells.every((d) => d.length === 24), `and twenty four hours each`);
    assert(
      f.closedDates.every((d, i, all) => i === 0 || all[i - 1]! < d),
      `${tierLabel(tier)}'s closed days are distinct and in date order`,
    );
  }
  // Low's whole tier fit comes from Low's own file, beside its page scoped fit (#2893).
  eq(fixtures[LOW_TIER], JSON.parse(readFileSync(LOW_FIXTURE_PATH, "utf8")) as VolumeFixture, "Low's whole tier fit is read from Low's own measurement");
  const lowWhole = WHOLE_TIER_MEASUREMENTS[LOW_TIER]!;
  eq(lowWhole.tierShare, null, "and covers the whole of Low");
  // #2870: every Low page is on Slate, so the Low fit is the whole tier too, and the
  // two are the same bookings rather than one a share of the other.
  eq(lowWhole.bookings, MEASURED_VOLUME_BASELINE.bookings, "the same bookings as the Low fit, now that it covers every Low page");
  eq(lowWhole.measuredOn, MEASURED_VOLUME_BASELINE.measuredOn, "from the same measurement");
  eq(renderTierBaselineModule({}).includes("WHOLE_TIER_MEASUREMENTS: Partial<Record<VolumeTier, VolumeBaseline>> = {\n};"), true, "no measurement renders an empty record, not a missing export");
}

// --- every measurement is listed to be thinned; none is applied as measured ---
{
  // Dan, 2026-09-29: a whole tier floor must never sit under a partially carried
  // tier as measured. #2893 lists each for thinning to the share Slate carries, and
  // keeps the anchors before any share is measured exactly as they were armed.
  eq(Object.keys(TIER_ANCHORS), [LOW_TIER], "TIER_ANCHORS, before a share is measured, is exactly Low");
  assert(TIER_ANCHORS[LOW_TIER] === MEASURED_VOLUME_BASELINE, "Low's anchor is its own committed measurement");
  eq(FLOOR_SCOPE.tier, LOW_TIER, "which is the tier Low's scope measures");
  // Ultra High was measured the same day and REFUSED as too thin: 3,379 bookings in
  // nine weeks fit a floor above zero at none of the 72 hours the alarm judges.
  // Pinned, so a measurement deleted by accident fails here.
  eq(Object.keys(WHOLE_TIER_MEASUREMENTS).sort(), ["1", "2", "3", "4"], "whole tier fits exist for Low, Medium, High and Very High, none for Ultra High");
  eq(TIER_MEASUREMENTS[LOW_TIER], [MEASURED_VOLUME_BASELINE, WHOLE_TIER_MEASUREMENTS[LOW_TIER]], "Low's measurements to thin are its two page fit and its whole tier fit");
  for (const tier of ["2", "3", "4"] as const) {
    eq(fixtures[tier]?.tier, tier, `${tierLabel(tier)}'s measurement counted ${tierLabel(tier)} (L70)`);
    eq(TIER_MEASUREMENTS[tier], [WHOLE_TIER_MEASUREMENTS[tier]], `and it is the one measurement ${tierLabel(tier)} thins`);
    assert(TIER_ANCHORS[tier] === undefined, `and not an anchor before a share is measured, so ${tierLabel(tier)} is unaffected until then`);
  }
  eq(TIER_MEASUREMENTS["5"], undefined, "Ultra High has nothing to thin, so it never has an anchor");
}

// --- the REPLAY: each tier's shipped alarm, armed, over real weeks it was not fitted on ---
//
// The same holdout scripts/test-volume-floors.ts runs for Low: fit on all but the
// last two measured weeks, then drive the shipped check every 5 minutes through
// those two. The page an anchor can cost is a false one on normal traffic, so that
// is what is asserted; how fast each tier sees an injected outage is printed as the
// evidence, since a thin tier's floors are honestly slow and that is the measurement.
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ZONE = "America/New_York";
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc d LLL HH:mm");
for (const [tier, fixture] of Object.entries(fixtures) as [VolumeTier, VolumeFixture][]) {
  const label = tierLabel(tier);
  const series = scopedSeries(fixture, wholeTierScope(fixture));
  const per = fixture.bucketMinutes * MIN;
  const endMs = fixture.startMs + series.counts.length * per;
  const holdoutFrom = endMs - 14 * DAY;
  const trained: VolumeBaseline = {
    ...WHOLE_TIER_MEASUREMENTS[tier]!,
    cells: fitFloorCells(headOf(series, series.counts.length - (14 * DAY) / per), fixture.zone, fixture.closedDates),
  };
  const policy = { baseline: trained, override30: null, override120: null };
  const hours = offlineHoursFor(fixture);
  const holdout = await replayLowVolume({ series, policy, businessHours: hours, fromMs: holdoutFrom, toMs: endMs, tickMinutes: 5, cooldownMs: 30 * MIN });
  console.log(`replay: ${label} holdout ${fmt(holdoutFrom)} to ${fmt(endMs)}, ${holdout.checked} ticks judged, ${holdout.pages.length} pages`);
  for (const p of holdout.pages) console.log(`replay:   ${label} page at ${fmt(p.atMs)}: ${p.text}`);
  eq(holdout.checked, 12 * 144, `${label}: the holdout judged every open tick of two weeks`);
  assert(holdout.pages.length <= 1, `${label}: at most one page in two real weeks of normal traffic (${holdout.pages.length})`);

  const delays: string[] = [];
  for (let d = 0; d < 14; d++) {
    const day = DateTime.fromMillis(holdoutFrom, { zone: ZONE }).startOf("day").plus({ days: d + 1 });
    const gapFrom = day.set({ hour: 13 }).toMillis();
    if (day.weekday > 5 || gapFrom + 150 * MIN > endMs) continue;
    const gapped = await replayLowVolume({
      series: withGap(series, gapFrom, gapFrom + 150 * MIN),
      policy,
      businessHours: hours,
      fromMs: gapFrom,
      toMs: gapFrom + 150 * MIN,
      tickMinutes: 5,
      cooldownMs: 30 * MIN,
    });
    delays.push(gapped.pages[0] ? `${(gapped.pages[0].atMs - gapFrom) / MIN}m` : "none");
  }
  console.log(`replay: ${label} weekday outages from 13:00 paged after ${delays.join(", ")}`);
}

finish();
