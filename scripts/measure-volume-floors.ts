// Fit the low booking volume floors to real traffic. Run:
//   pnpm measure:volume-floors
//
// WHY IT EXISTS (#1956). The floors the low volume alarm judges against were two
// hand typed numbers, one for every hour of the week, and nothing had ever measured
// either. This reads the bookings cal.com actually took, per landing page, and fits
// a floor per weekday and hour to the traffic Slate carries (FLOOR_SCOPE in
// scripts/lib/volume-floor-scope.ts).
//
// WHAT IT WRITES, both committed:
//   scripts/fixtures/calcom-low-bookings.json   bookings per 5 minute bucket per page
//                                               (counts only, nothing about any lead)
//   src/lib/monitor/volume-baseline.ts          the fitted floors the monitor reads
// scripts/test-volume-floors.ts re-derives the second from the first and fails when
// they differ, and replays the armed alarm against the first.
//
// WHAT COUNTS AS A BOOKING. A routing form response whose `routedToBookingUid` is
// set, placed at the moment the response was recorded, which is within minutes of
// the booking being created. cal.com's own bookings listing carries no landing page,
// and the page is exactly the dimension the first flip is cut along.
//
// It talks to cal.com, so it is deliberately not named `test-*.ts`.
//
// Env:
//   CALCOM_API_KEY   required
//   CALCOM_ORG_ID    default 19474
//   MEASURE_DAYS     how far back to read (default 63, nine whole weeks)
//   MEASURE_ZONE     the zone weekday and hour are judged in (default America/New_York)
//   MEASURE_PACE_MS  pacing between pages (default 550, measured in #2240)
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvFiles, envOr } from "./smoke-env.ts";
import { readRoutingResponses, tierOf } from "./lib/calcom-routing-responses.ts";
import {
  FLOOR_SCOPE,
  buildFixture,
  baselineFromFixture,
  renderBaselineModule,
  type VolumeFixture,
} from "./lib/volume-floor-scope.ts";
import { SERIES_BUCKET_MINUTES, WEEKDAY_NAMES, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";

const FIXTURE_PATH = "scripts/fixtures/calcom-low-bookings.json";
const BASELINE_PATH = "src/lib/monitor/volume-baseline.ts";

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

// REFIT=1 re-fits the floors from the COMMITTED measurement without reading cal.com,
// which is what a change to FLOOR_SCOPE or to the fit itself needs.
if (process.env.REFIT === "1") {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VolumeFixture;
  const baseline = baselineFromFixture(fixture, FLOOR_SCOPE);
  writeFileSync(BASELINE_PATH, renderBaselineModule(baseline));
  console.log(`Re-fitted from the measurement taken ${baseline.measuredOn}; nothing was read from cal.com.`);
  report(fixture, baseline);
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
const PACE_MS = Number(envOr(process.env.MEASURE_PACE_MS, "550"));
if (!Number.isInteger(DAYS) || DAYS < 14) {
  // Two weeks is two samples per weekday and hour, which is no distribution at all.
  console.error("FAILED (bad-input): MEASURE_DAYS must be a whole number of at least 14");
  process.exit(1);
}
if (!Number.isFinite(PACE_MS) || PACE_MS < 0) {
  // An unreadable pace becomes NaN, which a timer reads as no wait at all, and the
  // run then meets cal.com's rate limit on every page instead of refusing (L50).
  console.error("FAILED (bad-input): MEASURE_PACE_MS must be a number of milliseconds, 0 or more");
  process.exit(1);
}

async function calGet(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://api.cal.com/v2${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, "cal-api-version": "2024-06-14" },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const per = SERIES_BUCKET_MINUTES * 60_000;
const endMs = Math.floor(Date.now() / per) * per;
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

const fixture = buildFixture({
  rows: read.rows.map((r) => ({ ...r, tier: tierOf(r.code) })),
  tier: FLOOR_SCOPE.tier,
  startMs,
  endMs,
  bucketMinutes: SERIES_BUCKET_MINUTES,
  zone: ZONE,
  measuredOn: new Date(endMs).toISOString().slice(0, 10),
  formNames: [],
});
const missing = FLOOR_SCOPE.forms.filter((f) => !fixture.forms[f]);
if (missing.length > 0) {
  console.error(
    `FAILED (scope-unmeasured): no bookings for ${missing.map((m) => `"${m}"`).join(", ")}. ` +
      "A renamed form is the likely cause; update FLOOR_SCOPE rather than fitting floors to nothing.",
  );
  process.exit(3);
}

const baseline = baselineFromFixture(fixture, FLOOR_SCOPE);
writeFileSync(FIXTURE_PATH, JSON.stringify(fixture) + "\n");
writeFileSync(BASELINE_PATH, renderBaselineModule(baseline));

console.log(
  `Read ${read.rows.length} routing form responses over ${DAYS} days (${baseline.fromDate} to ${baseline.toDate}).`,
);
report(fixture, baseline);
