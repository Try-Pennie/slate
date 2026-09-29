/**
 * Whose traffic the low volume floors are fitted to, and how a baseline is built
 * from the committed measurement (#1956).
 *
 * THE SCOPE IS A DECISION, and it is made in ONE place: `LOW_PAGES_ON_SLATE` in
 * `src/lib/monitor/page-volume.ts`, which the per page alarm, the readiness gate and
 * the admin page read too. Dan, 2026-09-29 (#2878): the Low pilot launches on the
 * two pages already wired to Slate, Completed Application Review and its Follow Up
 * (`/booking/[SO_ID]` and `/my-offers/result`), so the Low floors are those two
 * pages' traffic. Income Verification follows when #2870 wires it.
 *
 * The scope has to MATCH what Slate carries, in both directions: floors fitted to
 * the whole tier while only one page flipped paged 108 to 283 times in two held out
 * weeks, and floors fitted to one page while all flip are slow and blind. The whole
 * tier scope this replaced (2026-09-25) paged 0 times on normal traffic and caught
 * a full outage in 30 minutes typically (85 at worst); the two page scope's own
 * numbers are printed by `scripts/test-volume-floors.ts` and quoted on #2878.
 *
 * THIS IS THE SCOPE OF THE ANCHOR MEASUREMENT, NOT OF WHAT SLATE CARRIES (#2874).
 * Widening the pilot to another tier needs no edit here and no refit: every count
 * the alarms read is filtered to the tier its floors describe, the tiers Slate
 * carries are derived from its own bookings, and each is learned from its own first
 * booking (`src/lib/monitor/volume-tiers.ts`, `volume-relearn.ts`). Change this
 * only to MEASURE Low again. Other tiers are measured with MEASURE_TIER into their
 * own fixtures and a saved, not in force, module (#2888, applied by #2893); the
 * admin page names the scope beside the floors it produced.
 *
 * The committed fixture keeps every Low page's series, not only the scoped one, so
 * a wider scope can be fitted and replayed offline from the same measurement.
 */
import { existsSync, readFileSync } from "node:fs";
import { fitFloorCells, type BookingSeries, type VolumeBaseline } from "../../src/lib/monitor/volume-floors.ts";
import { LOW_PAGES, LOW_PAGES_ON_SLATE, type LowPage, type LowPageId } from "../../src/lib/monitor/page-volume.ts";
import { LOW_TIER, VOLUME_TIERS, isVolumeTier, tierLabel, type VolumeTier } from "../../src/lib/monitor/volume-tiers.ts";
import { floorTable } from "../../src/lib/admin/volume-floor-table.ts";
import { DateTime } from "luxon";
import type { BusinessHoursConfig } from "../../src/lib/monitor/booking-volume.ts";

export interface FloorScope {
  /** The debt tier digit ("1" is Low). */
  tier: string;
  /** The cal.com routing forms (one per landing page) whose bookings Slate carries. */
  forms: string[];
  /** The scope in plain words, shown on /admin/alerts. */
  label: string;
}

/** "A, B and C": names joined as a sentence says them. */
function spoken(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const FLOOR_SCOPE: FloorScope = {
  tier: "1",
  // The Low pages Slate carries, from the one switch the per page alarm, the
  // readiness gate and the admin page all read (#2878), so the floors and the pages
  // judged against them are the same pages by construction (L41).
  forms: LOW_PAGES_ON_SLATE.map((p) => p.calcomForm),
  label: `Low debt bookings from the ${spoken(LOW_PAGES_ON_SLATE.map((p) => p.name))} pages, the Low pages that send their leads to Slate`,
};

/** The committed measurement: booking counts per bucket, per page, for one tier. */
export interface VolumeFixture {
  source: "calcom";
  measuredOn: string;
  zone: string;
  tier: string;
  startMs: number;
  bucketMinutes: number;
  /** Bookings per bucket, keyed by routing form name. Every form in the tier is present. */
  forms: Record<string, number[]>;
  /**
   * The days inside the measured span the org records as CLOSED (#2764), YYYY-MM-DD
   * in `zone`, read from `business_hours_exceptions` through the same loader the
   * availability gate uses. Recorded with the counts, so a refit from this file
   * leaves out exactly the days the measurement left out without reading anything.
   */
  closedDates: string[];
}

/** The scope's series: every scoped form's counts summed bucket by bucket. */
export function scopedSeries(fixture: VolumeFixture, scope: FloorScope): BookingSeries {
  if (scope.tier !== fixture.tier) {
    throw new Error(`the fixture measures tier ${fixture.tier}, the scope asks for tier ${scope.tier}`);
  }
  // A scope with no page (every Low page held off Slate) would fit floors of zero,
  // which can never breach and would still read as a measurement (L678, #2878).
  if (scope.forms.length === 0) throw new Error("the scope names no page, so there is no traffic to fit floors to");
  const lengths = new Set(Object.values(fixture.forms).map((c) => c.length));
  if (lengths.size !== 1) throw new Error("the fixture's forms cover different spans");
  const n = [...lengths][0]!;
  const counts = new Array<number>(n).fill(0);
  for (const name of scope.forms) {
    const series = fixture.forms[name];
    // A scoped page missing from the measurement would fit floors to nothing and
    // read as a very quiet page. Refuse by name instead (L100).
    if (!series) throw new Error(`the scope names "${name}", which the measurement does not hold`);
    series.forEach((v, i) => (counts[i]! += v));
  }
  return { startMs: fixture.startMs, bucketMinutes: fixture.bucketMinutes, counts };
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The baseline the committed module must equal, derived from the fixture. */
export function baselineFromFixture(fixture: VolumeFixture, scope: FloorScope): VolumeBaseline {
  const series = scopedSeries(fixture, scope);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const scoped = sum(series.counts);
  const tierTotal = sum(Object.values(fixture.forms).map(sum));
  const allForms = Object.keys(fixture.forms).every((f) => scope.forms.includes(f));
  const endMs = fixture.startMs + series.counts.length * fixture.bucketMinutes * 60_000;
  return {
    source: fixture.source,
    measuredOn: fixture.measuredOn,
    fromDate: isoDate(fixture.startMs),
    toDate: isoDate(endMs - 1),
    zone: fixture.zone,
    scope: scope.label,
    tierShare: allForms || tierTotal === 0 ? null : Math.round((scoped / tierTotal) * 100) / 100,
    bookings: scoped,
    cells: fitFloorCells(series, fixture.zone, fixture.closedDates),
  };
}

/**
 * Builds the fixture from rows read off cal.com. Only BOOKED responses in the tier
 * count, placed in the bucket their response was created in; the bucket grid runs
 * from `startMs` to `endMs` with no partial bucket at either end.
 */
export function buildFixture(opts: {
  rows: { formName: string; createdAt: string; tier: string | null; booked: boolean }[];
  tier: string;
  startMs: number;
  endMs: number;
  bucketMinutes: number;
  zone: string;
  measuredOn: string;
  formNames: string[];
  /** Every date the org records as closed; only those inside the span are kept. */
  closedDates: readonly string[];
}): VolumeFixture {
  const per = opts.bucketMinutes * 60_000;
  const n = Math.floor((opts.endMs - opts.startMs) / per);
  const forms: Record<string, number[]> = {};
  for (const name of opts.formNames) forms[name] = new Array<number>(n).fill(0);
  for (const r of opts.rows) {
    if (r.tier !== opts.tier || !r.booked) continue;
    const ms = Date.parse(r.createdAt);
    if (!Number.isFinite(ms)) continue;
    const i = Math.floor((ms - opts.startMs) / per);
    if (i < 0 || i >= n) continue;
    const series = (forms[r.formName] ??= new Array<number>(n).fill(0));
    series[i]! += 1;
  }
  // Drop forms that carried nothing in this tier, so the fixture holds the pages
  // that matter rather than every form the org ever made.
  for (const [name, counts] of Object.entries(forms)) {
    if (counts.every((v) => v === 0)) delete forms[name];
  }
  const fromDate = DateTime.fromMillis(opts.startMs, { zone: opts.zone }).toISODate() ?? "";
  const toDate = DateTime.fromMillis(opts.startMs + n * per - 1, { zone: opts.zone }).toISODate() ?? "";
  const closedDates = [...new Set(opts.closedDates)].filter((d) => d >= fromDate && d <= toDate).sort();
  return {
    source: "calcom",
    measuredOn: opts.measuredOn,
    zone: opts.zone,
    tier: opts.tier,
    startMs: opts.startMs,
    bucketMinutes: opts.bucketMinutes,
    forms,
    closedDates,
  };
}

/** The generated module's source text, so the measure command and the parity test agree on it byte for byte. */
export function renderBaselineModule(baseline: VolumeBaseline): string {
  const cells = baseline.cells
    .map((day) => `    [${day.map((c) => `[${c.floor30}, ${c.floor120}, ${c.typical120}]`).join(", ")}],`)
    .join("\n");
  return `// GENERATED by \`pnpm measure:volume-floors\` (#1956). Do not edit by hand:
// scripts/test-volume-floors.ts re-derives this from the committed measurement in
// scripts/fixtures/calcom-low-bookings.json and fails when the two differ.
import type { FloorCell, VolumeBaseline } from "./volume-floors.ts";

/** [floor30, floor120, typical120] per hour, one row per weekday from Monday. */
const RAW: [number, number, number][][] = [
${cells}
];

export const MEASURED_VOLUME_BASELINE: VolumeBaseline = {
  source: ${JSON.stringify(baseline.source)},
  measuredOn: ${JSON.stringify(baseline.measuredOn)},
  fromDate: ${JSON.stringify(baseline.fromDate)},
  toDate: ${JSON.stringify(baseline.toDate)},
  zone: ${JSON.stringify(baseline.zone)},
  scope: ${JSON.stringify(baseline.scope)},
  tierShare: ${JSON.stringify(baseline.tierShare)},
  bookings: ${baseline.bookings},
  cells: RAW.map((day) =>
    day.map(([floor30, floor120, typical120]): FloorCell => ({ floor30, floor120, typical120 })),
  ),
};
`;
}

/**
 * The org's stored week as read from production on 2026-09-25 (Monday to
 * Saturday, 08:00 to 20:00 Eastern), for REPORTING offline only: what the
 * measure command prints and what the replays judge. The monitor itself reads
 * the live `business_hours` row every tick.
 */
export const OFFLINE_OPEN_WEEK: BusinessHoursConfig = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};

/**
 * The week a REPLAY of a measurement judges in (#2764): the stored week above, plus
 * the closed days the measurement recorded, as the closed exceptions the live alarm
 * reads. A replay with no exceptions judges a holiday as an open day the monitor
 * never would, and reports pages the armed alarm could not have sent.
 */
export function offlineHoursFor(fixture: Pick<VolumeFixture, "closedDates">): BusinessHoursConfig {
  return {
    ...OFFLINE_OPEN_WEEK,
    exceptions: fixture.closedDates.map((on_date) => ({
      on_date,
      is_open: false,
      start_minute: null,
      end_minute: null,
      note: null,
    })),
  };
}

/**
 * One baseline per Low page (#2738): the same fit, on that page's own series. The
 * scope and share name the page, so a reader of any one of them knows whose
 * traffic its floors are.
 */
export function pageBaselinesFromFixture(fixture: VolumeFixture): Record<LowPageId, VolumeBaseline> {
  const out = {} as Record<LowPageId, VolumeBaseline>;
  for (const page of LOW_PAGES) out[page.id] = baselineFromFixture(fixture, pageScope(fixture, page));
  return out;
}

/** A page as a floor scope: its one routing form, in the fixture's tier. */
export function pageScope(fixture: VolumeFixture, page: LowPage): FloorScope {
  return { tier: fixture.tier, forms: [page.calcomForm], label: `Low debt bookings from the ${page.name} page` };
}

/** The generated per page module, rendered the same way as the tier's so the two cannot drift in shape. */
export function renderPageBaselineModule(baselines: Record<LowPageId, VolumeBaseline>): string {
  // The metadata is written as JSON and the cells as rows of triples, so the module
  // holds the numbers and nothing else: turning rows into cells is `cellsFromRows`
  // in volume-floors.ts, one function rather than a copy in every generated file.
  const entries = LOW_PAGES.map((page) => renderBaselineEntry(page.id, baselines[page.id])).join("\n");
  return [
    "// GENERATED by `pnpm measure:volume-floors` (#2738). Do not edit by hand:",
    "// scripts/test-page-volume.ts re-derives this from the committed measurement in",
    "// scripts/fixtures/calcom-low-bookings.json and fails when the two differ.",
    'import { cellsFromRows, type VolumeBaseline } from "./volume-floors.ts";',
    'import type { LowPageId } from "./page-volume.ts";',
    "",
    "/** Each Low page's floors: [floor30, floor120, typical120] per hour, one row per weekday from Monday. */",
    `export const ${PAGE_BASELINE_EXPORT}: Record<LowPageId, VolumeBaseline> = {`,
    entries,
    "};",
    "",
  ].join("\n");
}

/** The generated module's one export, named once for the renderer and its readers. */
const PAGE_BASELINE_EXPORT = "MEASURED_PAGE_BASELINES";

/**
 * One baseline as an entry of a generated record: its metadata as JSON, its cells as
 * rows of triples. Shared by the per page module and the per tier module, so the two
 * generated files cannot drift in shape.
 */
function renderBaselineEntry(key: string, baseline: VolumeBaseline): string {
  const { cells, ...meta } = baseline;
  const rows = cells
    .map((day) => `      [${day.map((c) => `[${c.floor30}, ${c.floor120}, ${c.typical120}]`).join(", ")}],`)
    .join("\n");
  const fields = Object.entries(meta)
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`)
    .join("\n");
  return `  ${JSON.stringify(key)}: {\n${fields}\n    cells: cellsFromRows([\n${rows}\n    ]),\n  },`;
}

// --- the tiers beside Low (#2888) ---
//
// Low's anchor is fitted to FLOOR_SCOPE and carries per page floors, because the
// pilot moves Low page by page. Every other tier is measured WHOLE: every form cal.com
// booked it through, with no page scope, since per page floors for those tiers are
// not a thing any alarm reads. Each tier's counts are committed in their own file,
// and the floors of every measured tier live in ONE generated module, rendered from
// every such file, so measuring one tier can never drop another's measurement.
// Low's whole tier fit is rendered there too, from Low's own file, beside its two page
// fit (#2893). None of these is applied as measured: each is thinned to the share of
// its tier Slate carries (`src/lib/monitor/carried-share.ts`).

/** Low's committed measurement, the file the command has always written. */
export const LOW_FIXTURE_PATH = "scripts/fixtures/calcom-low-bookings.json";

/** The generated module holding every measured tier's whole tier floors, Low's included. */
export const TIER_BASELINES_PATH = "src/lib/monitor/volume-baseline-tiers.ts";

/** Where a tier's committed measurement lives: Low's own file, or one per tier. */
export function tierFixturePath(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume floors: ${tier} is not a debt tier`);
  return tier === LOW_TIER ? LOW_FIXTURE_PATH : `scripts/fixtures/calcom-tier-${tier}-bookings.json`;
}

/** What one run of `pnpm measure:volume-floors` measures. */
export interface MeasureTarget {
  tier: VolumeTier;
  /** True for Low, which keeps FLOOR_SCOPE, its own module and its per page floors. */
  low: boolean;
  fixturePath: string;
}

/**
 * The tier a run measures, from MEASURE_TIER. Unset or blank is Low, which is what
 * the command measured before it took a tier, so every existing instruction to run
 * it still does what it said. Anything that is not exactly a tier digit is refused
 * by name, listing the tiers it accepts from the tier vocabulary itself (L41),
 * because a typo read as Low would overwrite Low's anchor with a run meant for
 * another tier.
 */
export function measureTargetFor(raw: string | undefined): { ok: true; target: MeasureTarget } | { ok: false; refusal: string } {
  const value = (raw ?? "").trim();
  const tier = value === "" ? LOW_TIER : value;
  if (!isVolumeTier(tier)) {
    const accepted = VOLUME_TIERS.map((t) => `${t} (${tierLabel(t)})`).join(", ");
    return {
      ok: false,
      refusal: `FAILED (bad-input): MEASURE_TIER must be one of ${accepted}, or unset for Low; got ${JSON.stringify(value.slice(0, 20))}`,
    };
  }
  return { ok: true, target: { tier, low: tier === LOW_TIER, fixturePath: tierFixturePath(tier) } };
}

/**
 * A tier as a floor scope: every form it booked through, which is the whole tier.
 * Low has one too since #2893, fitted from the same file as its two page fit, so that
 * Slate carrying more of Low than those two pages has a measurement to thin.
 */
export function wholeTierScope(fixture: VolumeFixture): FloorScope {
  if (!isVolumeTier(fixture.tier)) throw new Error(`volume floors: the measurement counts ${fixture.tier}, which is not a debt tier`);
  return {
    tier: fixture.tier,
    forms: Object.keys(fixture.forms),
    label: `Every ${tierLabel(fixture.tier)} debt booking from every landing page, the whole tier`,
  };
}

/** Every tier's committed measurement, Low's included, read from its own file where one exists. */
export function readTierFixtures(): Partial<Record<VolumeTier, VolumeFixture>> {
  const out: Partial<Record<VolumeTier, VolumeFixture>> = {};
  for (const tier of VOLUME_TIERS) {
    const path = tierFixturePath(tier);
    if (existsSync(path)) out[tier] = JSON.parse(readFileSync(path, "utf8")) as VolumeFixture;
  }
  return out;
}

/**
 * The baselines the tier module must hold, one per measurement. A measurement filed
 * under a tier it did not count is refused by name, so a saved measurement can never
 * describe a tier with another tier's traffic (L70).
 */
export function tierBaselinesFromFixtures(
  fixtures: Partial<Record<VolumeTier, VolumeFixture>>,
): Partial<Record<VolumeTier, VolumeBaseline>> {
  const out: Partial<Record<VolumeTier, VolumeBaseline>> = {};
  for (const tier of VOLUME_TIERS) {
    const fixture = fixtures[tier];
    if (!fixture) continue;
    if (fixture.tier !== tier) {
      throw new Error(`volume floors: the measurement filed under tier ${tier} counted tier ${fixture.tier}`);
    }
    out[tier] = baselineFromFixture(fixture, wholeTierScope(fixture));
  }
  return out;
}

/** The generated tier module's source text, so the measure command and the parity test agree on it byte for byte. */
export function renderTierBaselineModule(baselines: Partial<Record<VolumeTier, VolumeBaseline>>): string {
  const entries = VOLUME_TIERS.filter((t) => baselines[t]).map((t) => renderBaselineEntry(t, baselines[t]!));
  return [
    "// GENERATED by `MEASURE_TIER=<tier> pnpm measure:volume-floors` (#2888, #2893). Do not edit by hand:",
    "// scripts/test-volume-tier-anchors.ts re-derives this from the committed measurements in",
    "// scripts/fixtures/calcom-low-bookings.json and calcom-tier-<tier>-bookings.json and fails",
    "// when the two differ.",
    'import { cellsFromRows, type VolumeBaseline } from "./volume-floors.ts";',
    'import type { VolumeTier } from "./volume-tiers.ts";',
    "",
    "/**",
    " * cal.com measurements of each WHOLE tier: [floor30, floor120, typical120] per hour, one row",
    " * per weekday from Monday. Never applied as measured: a whole tier floor under a partially",
    " * carried tier's floors would raise them to traffic it cannot reach (Dan, 2026-09-29), so each",
    " * is thinned to the share of its tier Slate carries (#2893, carried-share.ts). Their typical",
    " * counts are also what a day's total is judged against, to tell bookings moved to cal.com",
    " * from bookings lost.",
    " */",
    "export const WHOLE_TIER_MEASUREMENTS: Partial<Record<VolumeTier, VolumeBaseline>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

/** How many of the hours the alarm judges carry a two hour floor above zero. */
export function judgedHourCoverage(
  baseline: VolumeBaseline,
  week: Pick<BusinessHoursConfig, "rules">,
): { withFloor: number; judged: number } {
  // Through the admin page's own table, so "an hour the alarm judges" means the
  // same thing here as on the page that shows these floors (L41).
  const cells = floorTable(baseline, week).rows.flatMap((r) => r.cells.filter((c) => c.floor120 !== null));
  return { withFloor: cells.filter((c) => (c.floor120 ?? 0) > 0).length, judged: cells.length };
}

/**
 * Null when a measurement carries a floor at some hour the alarm judges, else the
 * refusal. A measurement whose every judged floor is zero would be saved as a floor
 * that can never hold anything up, while reading as a real measurement of the tier
 * (L678).
 */
export function thinAnchorRefusal(baseline: VolumeBaseline, week: Pick<BusinessHoursConfig, "rules">): string | null {
  const { withFloor, judged } = judgedHourCoverage(baseline, week);
  if (withFloor > 0) return null;
  return (
    `FAILED (too-thin): ${baseline.bookings} bookings fit no floor above zero at any of the ${judged} hours the alarm judges, ` +
    "so a floor from them could never hold anything up. Nothing was written."
  );
}
