// #1956: `pnpm measure:volume-floors` refuses a setting it cannot read, by name,
// before it asks cal.com for anything.
//
// An unreadable MEASURE_PACE_MS becomes NaN, which a timer reads as no wait at all,
// so the run would meet cal.com's rate limit on every page rather than refusing
// (L50). The child runs with `fetch` replaced by one that throws, so a guard that
// regressed can never reach the network from a test (L2): it fails here instead.
import { spawnSync } from "node:child_process";
import { assert, finish } from "./lib/harness.ts";

const NO_NETWORK = "data:text/javascript,globalThis.fetch=()=>{throw new Error('network refused in test')}";

function run(env: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    ["--import", "./scripts/register-paths.mjs", "--import", NO_NETWORK, "scripts/measure-volume-floors.ts"],
    { env: { PATH: process.env.PATH ?? "", CALCOM_API_KEY: "not-a-real-key", ...env }, encoding: "utf8" },
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

finish();
