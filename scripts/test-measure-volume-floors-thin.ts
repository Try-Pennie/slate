// #2888: `pnpm measure:volume-floors` refuses a tier beside Low whose fit carries no
// floor above zero at any hour the alarm judges, and it refuses it on EVERY path
// that writes: the live cal.com read, REFIT=1 and RECORD_CLOSED_DAYS=1. The refusal
// first shipped on the live path only, so a refit or a recorded holiday could still
// commit an all zero anchor that reads as a measured floor and holds nothing up.
//
// Each mode is run for real, as a child process, in a TEMPORARY working directory,
// so every path the command writes lands there and never in the repo (L2). The
// network is replaced: cal.com answers one thin form, Supabase answers no closed
// days, and anything else is refused, so a regressed guard cannot reach a real
// service from a test.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";

const REPO = process.cwd();
const FIXTURE = "scripts/fixtures/calcom-tier-3-bookings.json";
const MODULE = "src/lib/monitor/volume-baseline-tiers.ts";

// One booked High response three days ago, and nothing else: far too thin to fit.
const STUB = `data:text/javascript,${encodeURIComponent(`
globalThis.fetch = async (input) => {
  const url = String(input && input.url ? input.url : input);
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.cal.com/")) {
    if (/routing-forms$/.test(url.split("?")[0])) return json({ data: [{ id: "f1", name: "Thin form" }] });
    return json({ data: [{ response: { x: { label: "xbc", value: "311" } }, createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), routedToBookingUid: "b1" }] });
  }
  if (url.startsWith("https://stub.supabase.test/")) return json([]);
  throw new Error("network refused in test: " + url);
};
`)}`;

/** A committed High measurement: three weeks from a Monday, `perBucket` bookings every 5 minutes. */
function fixture(perBucket: (i: number) => number): string {
  const startMs = DateTime.fromISO("2026-08-03T00:00", { zone: "America/New_York" }).toMillis();
  const n = (21 * 24 * 60) / 5;
  return JSON.stringify({
    source: "calcom",
    measuredOn: "2026-08-24",
    zone: "America/New_York",
    tier: "3",
    startMs,
    bucketMinutes: 5,
    forms: { "Thin form": Array.from({ length: n }, (_, i) => perBucket(i)) },
    closedDates: [],
  }) + "\n";
}
const THIN = fixture((i) => (i === 100 ? 1 : 0));
const THICK = fixture(() => 1);

/** Runs the command as MEASURE_TIER=3 in a fresh temporary tree, seeded with `committed` when given. */
function run(mode: Record<string, string>, committed: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "slate-thin-anchor-"));
  mkdirSync(join(dir, "scripts/fixtures"), { recursive: true });
  mkdirSync(join(dir, "src/lib/monitor"), { recursive: true });
  if (committed !== null) writeFileSync(join(dir, FIXTURE), committed);
  const r = spawnSync(
    process.execPath,
    ["--import", join(REPO, "scripts/register-paths.mjs"), "--import", STUB, join(REPO, "scripts/measure-volume-floors.ts")],
    {
      cwd: dir,
      encoding: "utf8" as const,
      // Every setting the command reads is set here, so nothing exported on the
      // machine running the suite can change what a case means (L439).
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CALCOM_API_KEY: "not-a-real-key",
        NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.test",
        SUPABASE_SECRET_KEY: "sb_secret_not_a_real_key",
        MEASURE_TIER: "3",
        MEASURE_PACE_MS: "0",
        ...mode,
      },
    },
  );
  const out = {
    status: r.status,
    err: `${r.stderr}${r.stdout}`,
    fixture: existsSync(join(dir, FIXTURE)) ? readFileSync(join(dir, FIXTURE), "utf8") : null,
    moduleWritten: existsSync(join(dir, MODULE)),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

for (const [name, mode, committed] of [
  ["the live read", {}, null],
  ["REFIT=1", { REFIT: "1" }, THIN],
  ["RECORD_CLOSED_DAYS=1", { RECORD_CLOSED_DAYS: "1" }, THIN],
] as const) {
  const r = run(mode, committed);
  eq(r.status, 6, `${name}: a High fit with no floor at any judged hour exits 6`);
  assert(r.err.includes("FAILED (too-thin)"), `${name}: and names the refusal (${r.err.slice(-200)})`);
  assert(!r.err.includes("network refused"), `${name}: having reached the fit, not a refused call`);
  assert(!r.moduleWritten, `${name}: no floors module is written`);
  // assert rather than eq, so a failure does not print a measurement twice (L445).
  assert(r.fixture === committed, `${name}: and the measurement on disk is exactly what was there before`);
}

// Positive controls: the same two offline modes with a measurement that CAN fit a
// floor write it, so the refusals above are the guard and not a command that
// refuses everything (L1).
for (const [name, mode] of [
  ["REFIT=1", { REFIT: "1" }],
  ["RECORD_CLOSED_DAYS=1", { RECORD_CLOSED_DAYS: "1" }],
] as const) {
  const r = run(mode, THICK);
  eq(r.status, 0, `control: ${name} with a measurement that fits a floor succeeds (${r.err.slice(-200)})`);
  assert(r.moduleWritten, `control: ${name} writes the floors module`);
}

finish();
