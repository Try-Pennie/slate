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

const NO_NETWORK = "data:text/javascript,globalThis.fetch=()=>{throw new Error('network refused in test')}";

// The caller's own MEASURE_* settings are blanked, which each command reads as its
// default, so an exported value on the machine running the suite cannot change what
// a case means (L439). The key is a stand in: fetch is replaced, so it is never sent.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, CALCOM_API_KEY: "not-a-real-key", MEASURE_DAYS: "", MEASURE_PACE_MS: "", ...extra };
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

finish();
