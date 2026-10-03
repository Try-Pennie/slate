// The production deploy, gradually (#3095).
//
// Run by the CI deploy job after `pnpm cf:build` (which carries the bundle env guard,
// #3078) and replaces `opennextjs-cloudflare deploy` there. It uploads the build twice,
// as a canary in cron standby and as the release, opens a 10/90 split, probes the
// canary through the version override header, then promotes the release to 100% and
// probes again, or restores the version that was serving. Every decision is in
// scripts/lib/gradual-deploy.ts and pinned offline by scripts/test-gradual-deploy.ts;
// this file is only I/O.
//
//   node --experimental-strip-types scripts/deploy-gradual.ts            # deploy
//   node --experimental-strip-types scripts/deploy-gradual.ts --settle   # end a split
//
// `--settle` is for the job's `if: failure() || cancelled()` step: a run cancelled or
// timed out between opening and ending the split cannot end it itself, so this reads
// what is serving and puts a leftover split's larger share (the old version) back at
// 100%. On a whole deployment it does nothing.
//
// env: CLOUDFLARE_API_TOKEN (read by wrangler), BOOKING_API_KEY_CANARY, GITHUB_SHA (or
//      PROBE_COMMIT), APP_URL, WRANGLER_ENV (the load test rehearsal only).
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANARY_VERSION_TIMEOUT_MS,
  CONFIRMATIONS,
  cronsFromWranglerConfig,
  EXIT,
  msUntilSplitWindowClear,
  overrideValue,
  planSettle,
  readDeploymentStatus,
  runGradualDeploy,
  uploadArgs,
  versionIdFromUploadOutput,
  workerNameFor,
  type GradualOps,
} from "./lib/gradual-deploy.ts";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_VERSION_TIMEOUT_MS, runProbe } from "./lib/post-deploy-probe.ts";
import { httpProbeDeps } from "./lib/post-deploy-probe-http.ts";
import { envArgs, jsonPart, ROOT, runCapture, runLoud } from "./lib/wrangler-cli.ts";
import { normalizeCommit } from "./stamp-build-info.ts";

// env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
const wranglerEnv = envArgs(process.env.WRANGLER_ENV);
const workerName = workerNameFor(process.env.WRANGLER_ENV);

function status() {
  return readDeploymentStatus(jsonPart(runCapture("pnpm", ["exec", "wrangler", "deployments", "status", "--json", ...wranglerEnv])));
}

function deploy(specs: string[], message: string): boolean {
  return runLoud("pnpm", ["exec", "wrangler", "versions", "deploy", ...specs, "-y", "--message", message, ...wranglerEnv]);
}

function summary(line: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${line}\n`, "utf8");
}

if (process.argv[2] === "--settle") {
  const plan = planSettle(status());
  if (plan.action === "none") {
    console.log("settle: production is serving one version at 100%; nothing to do.");
    process.exit(0);
  }
  if (plan.action === "refuse") {
    console.error(`::error title=production may be split::${plan.reason}. Run the Rollback workflow.`);
    process.exit(1);
  }
  const ok = deploy(plan.specs, "slate-settle");
  if (ok) {
    console.log(`settle: a split was left standing, so ${plan.specs[0]} was put back.`);
    summary(`A split was left standing by this run and was settled: ${plan.specs[0]}.`);
    // Exit non-zero even though the settle worked: the run it is cleaning up after did
    // not ship, and this job must not read green.
    process.exit(1);
  }
  console.error(`::error title=production may be split::could not put ${plan.specs[0]} back. Run the Rollback workflow now.`);
  process.exit(1);
}

const key = process.env.BOOKING_API_KEY_CANARY ?? "";
if (!key) {
  console.error(
    "::error title=gradual deploy cannot run::BOOKING_API_KEY_CANARY is unset, so neither version could be confirmed. Nothing was deployed.",
  );
  process.exit(EXIT.unreadable);
}
// env-ok: PROBE_COMMIT (a hand-run override; in CI the runner's own GITHUB_SHA is the input)
const commit = normalizeCommit(process.env.PROBE_COMMIT ?? process.env.GITHUB_SHA);
const appUrl = (process.env.APP_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
// env-ok: SMOKE_BUCKET (a local override only; CI wants the seeded SMOKE bucket)
const bucket = process.env.SMOKE_BUCKET ?? "SMOKE";

const crons = cronsFromWranglerConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
if (crons === null) {
  console.error(
    "::error title=gradual deploy cannot run::the cron schedule in wrangler.jsonc could not be read, so there is no knowing when the split may open without dropping a rare cron tick. Nothing was deployed.",
  );
  process.exit(EXIT.unreadable);
}

const scratch = mkdtempSync(join(tmpdir(), "slate-deploy-"));

const ops: GradualOps = {
  status: async () => status(),
  upload: async (kind) => {
    const out = join(scratch, `${kind}.ndjson`);
    const ok = runLoud(
      "pnpm",
      ["exec", "opennextjs-cloudflare", "upload", ...uploadArgs(kind, commit), ...wranglerEnv],
      { WRANGLER_OUTPUT_FILE_PATH: out },
    );
    if (!ok) return null;
    let text = "";
    try {
      text = readFileSync(out, "utf8");
    } catch {
      return null;
    }
    const id = versionIdFromUploadOutput(text);
    console.log(`  ${kind} version: ${id ?? "UNREADABLE"}`);
    return id;
  },
  deploy: async (specs, message) => deploy(specs, message),
  probe: async (stage, canaryId) => {
    const deps = httpProbeDeps({
      appUrl,
      key,
      bucket,
      versionOverride: stage === "canary" && canaryId ? overrideValue(canaryId, workerName) : null,
    });
    return runProbe(deps, {
      expectedCommit: commit,
      versionTimeoutMs: stage === "canary" ? CANARY_VERSION_TIMEOUT_MS : DEFAULT_VERSION_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      confirmations: CONFIRMATIONS,
    });
  },
  triggers: async () => runLoud("pnpm", ["exec", "wrangler", "triggers", "deploy", ...wranglerEnv]),
  waitForCronWindow: async () => {
    const wait = msUntilSplitWindowClear(Date.now(), crons);
    if (wait > 0) {
      console.log(`  waiting ${Math.ceil(wait / 1000)}s so no hourly or daily cron tick falls inside the split`);
      await new Promise((r) => setTimeout(r, wait));
    }
  },
  log: (line) => console.log(`  ${line}`),
};

let result;
try {
  result = await runGradualDeploy(ops);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

summary(`**Gradual deploy of ${commit}:** ${result.message}`);
if (result.exit === EXIT.promoted) {
  console.log(`\n  ${result.message}\n`);
} else {
  console.error(`::error title=gradual deploy (exit ${result.exit}, production on ${result.end} version)::${result.message}`);
}
process.exit(result.exit);
