// #1956: `pnpm measure:volume-floors` and its sibling `pnpm measure:lead-hours`,
// which share the cal.com paging reader, refuse a setting they cannot read, by
// name, before they ask cal.com for anything.
//
// An unreadable MEASURE_PACE_MS becomes NaN, which a timer reads as no wait at all,
// so the run would meet cal.com's rate limit on every page rather than refusing
// (L50). The child runs with `fetch` replaced by one that throws, so a guard that
// regressed can never reach the network from a test (L2): it fails here instead.
import { spawnSync } from "node:child_process";
import { assert, finish } from "./lib/harness.ts";
import { measureEndOrRefusal } from "./lib/calcom-routing-responses.ts";

const NO_NETWORK = "data:text/javascript,globalThis.fetch=()=>{throw new Error('network refused in test')}";

// The caller's own MEASURE_* settings are blanked, which each command reads as its
// default, so an exported value on the machine running the suite cannot change what
// a case means (L439). The key is a stand in: fetch is replaced, so it is never sent.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CALCOM_API_KEY: "not-a-real-key",
    MEASURE_DAYS: "",
    MEASURE_PACE_MS: "",
    MEASURE_TIER: "",
    MEASURE_END: "",
    REFIT: "",
    RECORD_CLOSED_DAYS: "",
    ...extra,
  };
}

function run(env: Record<string, string>, script = "scripts/measure-volume-floors.ts") {
  const r = spawnSync(
    process.execPath,
    ["--import", "./scripts/register-paths.mjs", "--import", NO_NETWORK, script],
    { env: childEnv(env), encoding: "utf8" as const },
  );
  return { status: r.status, err: `${r.stderr}${r.stdout}` };
}

{
  const r = run({ MEASURE_PACE_MS: "abc" });
  assert(r.status === 1, `an unreadable pace exits 1 (got ${r.status})`);
  assert(r.err.includes("FAILED (bad-input): MEASURE_PACE_MS"), "and names the pace as what it could not read");
  assert(!r.err.includes("network refused"), "and refused before any cal.com call");
}
{
  const r = run({ MEASURE_PACE_MS: "-5" });
  assert(r.status === 1 && r.err.includes("MEASURE_PACE_MS"), "a negative pace is refused the same way");
}
{
  // Positive control: the sibling guard on the span still refuses on its own terms,
  // so the pace message above is not simply the first thing this script prints.
  const r = run({ MEASURE_DAYS: "3" });
  assert(r.status === 1, `too short a span exits 1 (got ${r.status})`);
  assert(r.err.includes("MEASURE_DAYS") && !r.err.includes("MEASURE_PACE_MS"), "and names the span, not the pace");
}
{
  // And a readable pace gets past both guards to the network, which this test has
  // replaced, proving the refusals above came from the guards and not from a script
  // that refuses everything.
  const r = run({ MEASURE_PACE_MS: "0" });
  assert(r.err.includes("network refused"), "a readable pace passes the guards and reaches for cal.com");
}

// #2888: MEASURE_TIER picks the tier, and a value that is not a tier is refused by
// name before anything is read or written, in every mode, since a refit for the
// wrong tier rewrites a committed anchor as surely as a live run does.
for (const mode of [{}, { REFIT: "1" }, { RECORD_CLOSED_DAYS: "1" }] as Record<string, string>[]) {
  for (const bad of ["9", "low", "1%"]) {
    const r = run({ ...mode, MEASURE_TIER: bad, MEASURE_PACE_MS: "0" });
    const label = `MEASURE_TIER=${bad}${mode.REFIT ? " with REFIT" : mode.RECORD_CLOSED_DAYS ? " with RECORD_CLOSED_DAYS" : ""}`;
    assert(r.status === 1, `${label} exits 1 (got ${r.status})`);
    assert(r.err.includes("FAILED (bad-input): MEASURE_TIER"), `${label} names the tier as what it could not read`);
    assert(!r.err.includes("network refused"), `${label} refuses before any cal.com call`);
  }
}
{
  // Positive control: a real tier passes the guard and reaches for cal.com, so the
  // refusals above came from the tier guard and not from a script refusing everything.
  const r = run({ MEASURE_TIER: "3", MEASURE_PACE_MS: "0" });
  assert(r.err.includes("network refused"), "MEASURE_TIER=3 passes the guard and reaches for cal.com");
  assert(!r.err.includes("MEASURE_TIER"), "and says nothing about the tier");
}

{
  // The sibling reads the same pace into the same paging reader, so it refuses the
  // same way (fix the class, L30).
  const r = run({ MEASURE_PACE_MS: "abc" }, "scripts/measure-lead-hours.ts");
  assert(r.status === 1, `measure:lead-hours exits 1 on an unreadable pace (got ${r.status})`);
  assert(r.err.includes("FAILED (bad-input): MEASURE_PACE_MS"), "and names the pace");
  assert(!r.err.includes("network refused"), "before any cal.com call");
  const ok = run({ MEASURE_PACE_MS: "0" }, "scripts/measure-lead-hours.ts");
  assert(ok.err.includes("network refused"), "and a readable pace still reaches for cal.com");
}

// #2888, #2494: MEASURE_END pins the end of the measured span. Since the split went
// to 50/50 on every tier (2026-10-01 15:46 UTC) cal.com carries about half of each
// tier, so a span ending now measures half the traffic it claims to; the span has
// to end before the split, and an end that cannot be read must be refused rather
// than read as "now", which is the one end that silently measures the wrong thing.
{
  const now = Date.parse("2026-10-01T19:00:00Z");
  const blank = measureEndOrRefusal("", now);
  assert(blank.ok && blank.endMs === now, "a blank MEASURE_END is the moment of the run");
  const pinned = measureEndOrRefusal("2026-10-01T15:45:00Z", now);
  assert(pinned.ok && pinned.endMs === Date.parse("2026-10-01T15:45:00Z"), "an instant with a zone is taken as written");
  const offset = measureEndOrRefusal("2026-10-01T11:45:00-04:00", now);
  assert(offset.ok && offset.endMs === Date.parse("2026-10-01T15:45:00Z"), "an offset reads as the same instant");
  for (const bad of ["yesterday", "2026-10-01T15:45:00", "2026-10-01", "2026-13-01T00:00:00Z", "2026-10-02T00:00:00Z"]) {
    const r = measureEndOrRefusal(bad, now);
    assert(!r.ok && r.refusal.startsWith("FAILED (bad-input): MEASURE_END"), `MEASURE_END=${bad} is refused by name`);
  }
}
for (const script of ["scripts/measure-volume-floors.ts", "scripts/measure-lead-hours.ts"]) {
  const r = run({ MEASURE_END: "not-a-time", MEASURE_PACE_MS: "0" }, script);
  assert(r.status === 1, `${script} exits 1 on an unreadable MEASURE_END (got ${r.status})`);
  assert(r.err.includes("FAILED (bad-input): MEASURE_END"), `${script} names the end as what it could not read`);
  assert(!r.err.includes("network refused"), `${script} refuses before any cal.com call`);
  const ok = run({ MEASURE_END: "2026-10-01T15:45:00Z", MEASURE_PACE_MS: "0" }, script);
  assert(ok.err.includes("network refused"), `${script} with a readable MEASURE_END still reaches for cal.com`);
}

finish();
