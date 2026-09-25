/**
 * Whose traffic the low volume floors are fitted to, and how a baseline is built
 * from the committed measurement (#1956).
 *
 * THE SCOPE IS A DECISION, and it lives here in one place. The first flip routes
 * one landing page's Low debt leads through Slate while cal.com keeps the rest
 * (docs/parallel-run-plan.md, Phase 3). Measured 2026-09-25, the Completed
 * Application Review page carries 50% of the Low tier's bookings, so a floor fitted
 * to the whole tier is one that page's traffic misses about half the time, and the
 * alarm would page every afternoon of the pilot.
 *
 * When the flip widens, change `FLOOR_SCOPE.forms` to every page Slate then carries
 * and run `pnpm measure:volume-floors`. The admin page names the scope and its share
 * beside the floors, so a scope nobody updated is visible to whoever arms the alarm.
 *
 * The committed fixture keeps every Low page's series, not only the scoped one, so
 * a wider scope can be fitted and replayed offline from the same measurement.
 */
import { fitFloorCells, type BookingSeries, type VolumeBaseline } from "../../src/lib/monitor/volume-floors.ts";

export interface FloorScope {
  /** The debt tier digit ("1" is Low). */
  tier: string;
  /** The cal.com routing forms (one per landing page) whose bookings Slate carries. */
  forms: string[];
  /** The scope in plain words, shown on /admin/alerts. */
  label: string;
}

export const FLOOR_SCOPE: FloorScope = {
  tier: "1",
  forms: ["Completed Application Review (/booking ai_agent_eligible false and /my-offers/result)"],
  label: "Low debt bookings from the Completed Application Review page, the first page to move to Slate",
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
}

/** The scope's series: every scoped form's counts summed bucket by bucket. */
export function scopedSeries(fixture: VolumeFixture, scope: FloorScope): BookingSeries {
  if (scope.tier !== fixture.tier) {
    throw new Error(`the fixture measures tier ${fixture.tier}, the scope asks for tier ${scope.tier}`);
  }
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
    cells: fitFloorCells(series, fixture.zone),
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
  return {
    source: "calcom",
    measuredOn: opts.measuredOn,
    zone: opts.zone,
    tier: opts.tier,
    startMs: opts.startMs,
    bucketMinutes: opts.bucketMinutes,
    forms,
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
