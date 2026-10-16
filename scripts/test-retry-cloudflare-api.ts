// The load test's wrangler calls retry a Cloudflare API that failed on ITS side, and
// nothing else (#3567).
//
// Load run 37970129958 lost its whole verdict to one 504 from Cloudflare's own API: the
// fault leg's `wrangler deploy` read the Worker's secrets, got `504 Gateway Timeout`, and
// the judge had no fault result and ruled the run INCOMPLETE after forty five minutes of
// load. `scripts/loadtest/retry-cloudflare-api.sh` runs a command again only when its
// output shows the API answered with a 5xx or a malformed reply; a refusal of our own
// making (a bad config, a 4xx) fails at once, since running it again changes nothing
// (L527). The wait between attempts is `RETRY_CLOUDFLARE_WAIT_S`, set to 0 here (L524).
//
// Run: node --experimental-strip-types scripts/test-retry-cloudflare-api.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPT = join(import.meta.dirname, "loadtest", "retry-cloudflare-api.sh");
assert(existsSync(SCRIPT), "the retry wrapper exists");

/** A fake command that prints `outputs[n]` and exits `codes[n]` on its n-th call, counting calls in a file. */
function fake(outputs: string[], codes: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "retry-cf-"));
  const count = join(dir, "count");
  writeFileSync(count, "0");
  const cmd = join(dir, "cmd.sh");
  const cases = outputs.map((o, i) => `  ${i}) printf '%s\\n' ${JSON.stringify(o)}; exit ${codes[i]} ;;`).join("\n");
  writeFileSync(
    cmd,
    `#!/bin/bash\nn=$(cat "${count}"); echo $((n + 1)) > "${count}"\ncase "$n" in\n${cases}\n  *) echo "called too often"; exit 99 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return { cmd, calls: () => Number(readFileSync(count, "utf8").trim()) };
}
const run = (cmd: string, extraEnv: Record<string, string> = {}) =>
  spawnSync("/bin/bash", [SCRIPT, cmd, "--some-arg"], { encoding: "utf8", env: { ...process.env, RETRY_CLOUDFLARE_WAIT_S: "0", ...extraEnv } });

{
  // The run's own failure: a 504 from the API, then a clean deploy.
  const f = fake(["GET /accounts/x/workers/scripts/slate-loadtest/secrets -> 504 Gateway Timeout", "Deployed slate-loadtest"], [1, 0]);
  const r = run(f.cmd);
  eq(r.status, 0, "a 504 from Cloudflare's API is retried, and the retry's success is the result");
  eq(f.calls(), 2, "and the command ran twice");
  assert(r.stdout.includes("Deployed slate-loadtest"), "and the retry's output is passed through");
  assert(`${r.stdout}${r.stderr}`.includes("504"), "and the failure it retried is not hidden");
}
{
  const f = fake(["Received a malformed response from the API", "Deployed"], [1, 0]);
  eq(run(f.cmd).status, 0, "a malformed reply from the API is retried too");
}
{
  // A refusal of our own making fails at once: running it again changes nothing.
  const f = fake(["\u2718 [ERROR] Missing entry-point to Worker script", "Deployed"], [1, 0]);
  const r = run(f.cmd);
  eq(r.status, 1, "a failure that is not the API's own is not retried, and its exit code stands");
  eq(f.calls(), 1, "it ran once");
}
{
  const f = fake(["PUT /accounts/x/workers/scripts/s -> 403 Forbidden", "Deployed"], [1, 0]);
  eq(run(f.cmd).status, 1, "a 4xx from the API is ours to fix, never retried");
  eq(f.calls(), 1, "and ran once");
}
{
  // Bounded: an API that keeps failing fails the step after the last attempt, with its own code.
  const f = fake(["-> 502 Bad Gateway", "-> 503 Service Unavailable", "-> 504 Gateway Timeout"], [1, 1, 7]);
  const r = run(f.cmd);
  eq(f.calls(), 3, "three attempts and no more");
  eq(r.status, 7, "the last attempt's exit code is the step's");
}
{
  const f = fake(["Deployed"], [0]);
  eq(run(f.cmd).status, 0, "a command that succeeds runs once");
  eq(f.calls(), 1, "once");
}

{
  // Every wrangler deploy the load test makes goes through the wrapper, so the next one
  // added cannot quietly be the one a 504 takes the run down with (L613).
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "loadtest.yml"), "utf8");
  // #3561: the object workers deploy through scripts/deploy-object-workers.ts, which runs
  // `wrangler deploy` itself, so its line is a deploy too.
  const deploys = workflow
    .split("\n")
    .filter((l) => /\bwrangler deploy\b|scripts\/deploy-object-workers\.ts/.test(l) && !l.trim().startsWith("#"));
  assert(deploys.length >= 4, `the guard found the workflow's deploys (positive control: ${deploys.length})`);
  const bare = deploys.filter((l) => !l.includes("retry-cloudflare-api.sh"));
  eq(bare.length, 0, `every wrangler deploy in loadtest.yml goes through retry-cloudflare-api.sh (bare: ${JSON.stringify(bare.map((l) => l.trim()))})`);
}

finish();
