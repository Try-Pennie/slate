// Slate's own automation authenticates with the canary's key, never the shared one
// (#2822). Run:
//   node --experimental-strip-types scripts/test-canary-key-wiring.ts
//
// Every shared key sighting in `api_caller_seen` is read as a partner's once the canary
// has moved to `BOOKING_API_KEY_CANARY`. That reading is only true while nothing of ours
// sends the shared key, so this holds every workflow and every script to it, proves the
// scan still bites by putting the old wiring back in memory, and proves the deploy probe
// refuses loudly (rather than falling back to the shared key) when the canary key is
// missing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SHARED_KEY_WORKFLOW_EXEMPT,
  scriptSharedKeyReads,
  sharedKeyScriptExempt,
  workflowSharedKeyHits,
} from "./lib/scan-canary-key-wiring.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOWS = join(ROOT, ".github/workflows");
const SCRIPTS = join(ROOT, "scripts");

// --- the scan, on fixtures --------------------------------------------------------------
{
  eq(workflowSharedKeyHits("        env:\n          BOOKING_API_KEY: ${{ secrets.BOOKING_API_KEY }}\n").length, 1, "an env line wiring the shared secret is caught");
  eq(workflowSharedKeyHits('            -H "authorization: Bearer $BOOKING_API_KEY"\n').length, 1, "a shell line sending it is caught");
  eq(workflowSharedKeyHits("          BOOKING_API_KEY_CANARY: ${{ secrets.BOOKING_API_KEY_CANARY }}\n").length, 0, "the canary's own key is not the shared one");
  eq(workflowSharedKeyHits("      # the shared BOOKING_API_KEY is a partner's now\n").length, 0, "a comment explaining it is not a use of it");
  eq(workflowSharedKeyHits("          X: 1  # not BOOKING_API_KEY\n").length, 0, "nor is a trailing comment");

  eq(scriptSharedKeyReads('const KEY = process.env.BOOKING_API_KEY ?? "";').length, 1, "a script reading the shared key is caught");
  eq(scriptSharedKeyReads('const apiKey = envOr("BOOKING_API_KEY", "");').length, 1, "and so is its name handed to an env helper");
  eq(scriptSharedKeyReads('const k = process.env["BOOKING_API_KEY"];').length, 1, "and a bracket read");
  eq(scriptSharedKeyReads('const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";').length, 0, "the canary's key is fine");
  eq(scriptSharedKeyReads("// was process.env.BOOKING_API_KEY before #2822").length, 0, "a comment is not a read");

  assert(sharedKeyScriptExempt("loadtest/book.ts") !== null, "the load test is exempt, with a reason");
  eq(sharedKeyScriptExempt("smoke-lib.ts"), null, "a smoke script is not");
}

// --- the real tree ------------------------------------------------------------------------
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
assert(workflowFiles.length > 5, `the scan read the workflows (${workflowFiles.length})`);
for (const f of Object.keys(SHARED_KEY_WORKFLOW_EXEMPT)) {
  assert(workflowFiles.includes(f), `the exemption for ${f} names a workflow that exists, so a stale entry cannot sit here reading as a decision`);
}
for (const f of workflowFiles) {
  if (SHARED_KEY_WORKFLOW_EXEMPT[f]) continue;
  const hits = workflowSharedKeyHits(readFileSync(join(WORKFLOWS, f), "utf8"));
  eq(hits.map((h) => `${f}:${h.line} ${h.text}`), [], `${f} sends the canary's key, never the shared one`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === "node_modules" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
  });
}
const scriptFiles = walk(SCRIPTS);
let judged = 0;
for (const p of scriptFiles) {
  const rel = relative(SCRIPTS, p);
  if (sharedKeyScriptExempt(rel)) continue;
  judged++;
  const hits = scriptSharedKeyReads(readFileSync(p, "utf8"));
  eq(hits.map((h) => `${rel}:${h.line} ${h.text}`), [], `scripts/${rel} reads the canary's key, never the shared one`);
}
assert(judged > 50, `the scan judged the scripts tree (${judged} files)`);

// The canary lanes really are wired to the canary's key, not merely unwired from the
// shared one: an empty step would pass the scan above.
for (const f of ["smoke-canary.yml", "burst-counter.yml", "router-replay.yml", "ci.yml", "schedule-parity.yml", "kill-switch.yml"]) {
  const text = readFileSync(join(WORKFLOWS, f), "utf8");
  assert(/BOOKING_API_KEY_CANARY:\s*\$\{\{\s*secrets\.BOOKING_API_KEY_CANARY\s*\}\}/.test(text), `${f} is given secrets.BOOKING_API_KEY_CANARY`);
}

// --- positive control: the old wiring, put back in memory, is caught -----------------------
{
  const real = readFileSync(join(WORKFLOWS, "smoke-canary.yml"), "utf8");
  const reverted = real.replaceAll("BOOKING_API_KEY_CANARY", "BOOKING_API_KEY");
  assert(workflowSharedKeyHits(reverted).length >= 5, "reverting the canary workflow to the shared key is caught on every step");
  const lib = readFileSync(join(SCRIPTS, "smoke-lib.ts"), "utf8");
  assert(scriptSharedKeyReads(lib.replaceAll("BOOKING_API_KEY_CANARY", "BOOKING_API_KEY")).length >= 1, "and so is reverting the smoke lib");
}

// --- failure path: the deploy probe refuses without the canary key --------------------------
//
// With ONLY the shared key present it must refuse, naming the canary key, rather than
// quietly authenticating as `shared`. It exits before any network call, so this reaches
// nothing.
{
  const env = { ...process.env, BOOKING_API_KEY: "a shared key value", APP_URL: "http://127.0.0.1:9" } as Record<string, string | undefined>;
  delete env.BOOKING_API_KEY_CANARY;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPTS, "post-deploy-probe.ts")], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
  eq(r.status, 1, "the probe exits 1 with no canary key");
  assert(/BOOKING_API_KEY_CANARY is unset/.test(r.stderr), `and names the missing secret (got: ${r.stderr.trim()})`);

  const blank = { ...env, BOOKING_API_KEY_CANARY: "" };
  const r2 = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPTS, "post-deploy-probe.ts")], {
    env: blank as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
  eq(r2.status, 1, "an EMPTY canary key, which is what an unset repo secret interpolates to, refuses the same way");
}

finish();
