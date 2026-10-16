// The production deploy, gradually (#3095).
//
// Run by the CI deploy job after `pnpm cf:build` (which carries the bundle env guard,
// #3078) and replaces `opennextjs-cloudflare deploy` there. It uploads the build twice,
// as a canary in cron standby and as the release, opens a 10/90 split, probes the
// canary through the version override header, then promotes the release to 100% and
// probes again, or restores the version that was serving. Last, once Slate is promoted
// and healthy, it deploys the log tail worker (slate-log-tail, #3160) whole: that
// worker binds to an entrypoint of Slate's (#3191), so it can only follow Slate, never
// lead it. First of all, before anything of Slate's is uploaded, it deploys the object
// workers (the confirm line's, #3500, the burst limiter's, #3555, the token holder's,
// #3512), which Slate's bindings name, so they must lead; each only when its bundle or
// config differs from the version serving (#3561), since a deploy restarts its objects,
// and the log says which were skipped and why. Every decision is in scripts/lib/gradual-deploy.ts and pinned offline by
// scripts/test-gradual-deploy.ts; this file is only I/O.
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
import { isCanaryView, readVersionView } from "./lib/rollback-plan.ts";
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
  readSplitRecords,
  settleDecision,
  shouldDeployTailWorker,
  runGradualDeploy,
  uploadArgs,
  versionIdFromUploadOutput,
  uploadRefusalFromOutput,
  workerNameFor,
  type GradualOps,
} from "./lib/gradual-deploy.ts";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_VERSION_TIMEOUT_MS, runProbe } from "./lib/post-deploy-probe.ts";
import { httpProbeDeps } from "./lib/post-deploy-probe-http.ts";
import { objectWorkerOps } from "./lib/object-worker-io.ts";
import { deployTargetLabel } from "./lib/object-worker-skip.ts";
import { envArgs, establishTarget, jsonPart, ROOT, runCapture, runLoud } from "./lib/wrangler-cli.ts";
import { retarget } from "./lib/wrangler-target.ts";
import { normalizeCommit } from "./stamp-build-info.ts";

// Before anything else, settle included: which Worker this is, said out loud, and a
// refusal when it is not the one WRANGLER_ENV names (#3165).
const target = establishTarget(EXIT.unreadable);

// env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
const wranglerEnv = envArgs(process.env.WRANGLER_ENV);
const workerName = workerNameFor(process.env.WRANGLER_ENV);

function status() {
  return readDeploymentStatus(jsonPart(runCapture("pnpm", ["exec", "wrangler", "deployments", "status", "--json", ...wranglerEnv])));
}

function deploy(specs: string[], message: string): boolean {
  return runLoud("pnpm", ["exec", "wrangler", "versions", "deploy", ...specs, "-y", "--message", message, ...wranglerEnv]);
}

/** Whether a version is a cron standby canary, from its own annotation; null when the
 *  view could not be read. */
function isCronStandby(versionId: string): boolean | null {
  return isCanaryView(
    readVersionView(jsonPart(runCapture("pnpm", ["exec", "wrangler", "versions", "view", versionId, "--json", ...wranglerEnv]))),
  );
}

// What this run did to the deployment, for the settle step to decide from (#3095). The
// CI job sets it to a file under the runner's temp directory, shared by both steps.
// env-ok: DEPLOY_STATE_FILE (an internal handoff between two steps of one job; a hand
//   run without it records nothing and its settle reads the deployment)
const stateFile = process.env.DEPLOY_STATE_FILE ?? "";

function readState(): string | null {
  try {
    return readFileSync(stateFile, "utf8");
  } catch {
    return null;
  }
}

function summary(line: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${retarget(line, target)}\n`, "utf8");
}

if (process.argv[2] === "--settle") {
  // Decided from what the run RECORDED: a run that never attempted the split (a gate
  // refusal, a failed build or upload) never touched production, and reading the
  // deployment then could only page "production may be split" on a failed read.
  // Without a state file (a hand run) there is no record, so it reads.
  if (stateFile && settleDecision(readSplitRecords(readState())).action === "none") {
    console.log("settle: this run never opened the split, or recorded ending it whole, so it left nothing to settle.");
    process.exit(0);
  }
  const plan = planSettle(status());
  if (plan.action === "none") {
    console.log("settle: production is serving one version at 100%; nothing to do.");
    process.exit(0);
  }
  if (plan.action === "refuse") {
    console.error(`::error title=production may be split::${plan.reason}. Run the Rollback workflow.`);
    process.exit(1);
  }
  const larger = plan.specs[0].split("@")[0];
  const standby = isCronStandby(larger);
  if (standby !== false) {
    console.error(
      `::error title=production may be split::the leftover split's larger share ${larger} ${standby === null ? "could not be checked for cron standby" : "is a cron standby canary"}, so it was NOT put back at 100% (that would switch every cron lane off). End the split by hand (DEPLOY.md, Rollback).`,
    );
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
// env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
const objectOps = objectWorkerOps(process.env.WRANGLER_ENV, (line) => console.log(`  ${line}`));

const ops: GradualOps = {
  status: async () => status(),
  upload: async (kind) => {
    const out = join(scratch, `${kind}.ndjson`);
    const ok = runLoud(
      "pnpm",
      ["exec", "opennextjs-cloudflare", "upload", ...uploadArgs(kind, commit), ...wranglerEnv],
      { WRANGLER_OUTPUT_FILE_PATH: out },
    );
    let text = "";
    try {
      text = readFileSync(out, "utf8");
    } catch {
      return null;
    }
    // #3352: a refusal the run can name, from the record wrangler writes on a failure.
    if (!ok) return uploadRefusalFromOutput(text) === "pending-do-migration" ? { refused: "pending-do-migration" } : null;
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
  tailWorker: async () => {
    if (!shouldDeployTailWorker(process.env.WRANGLER_ENV)) {
      console.log("  not deploying the log tail worker: this environment has none");
      return true;
    }
    return runLoud("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.log-tail.jsonc"]);
  },
  // #3500, #3555: an object worker, in the same environment as the Slate it serves, and
  // #3561 only when it changed: the same I/O the hand deploy and the load run use.
  objectWorkerFacts: (config) => objectOps.facts(config),
  objectWorker: (config, message) => objectOps.deploy(config, message),
  objectWorkerStamp: (config) => objectOps.servingStamp(config),
  // #3560: never a confirm line build older than the app serving now.
  liveAppProtocol: () => objectOps.liveAppProtocol(),
  isCronStandby: async (id) => isCronStandby(id),
  record: (event) => {
    if (stateFile) appendFileSync(stateFile, `${event}\n`, "utf8");
  },
  waitForCronWindow: async () => {
    const wait = msUntilSplitWindowClear(Date.now(), crons);
    if (wait > 0) {
      console.log(`  waiting ${Math.ceil(wait / 1000)}s so no hourly or daily cron tick falls inside the split`);
      await new Promise((r) => setTimeout(r, wait));
    }
  },
  log: (line) => console.log(`  ${line}`),
  // #3854: an annotation AND a summary line, so a check that did not run is seen by
  // whoever reads the run, not only by whoever reads the middle of its log.
  warn: (line) => {
    console.warn(`::warning title=confirm line protocol not checked::${line}`);
    summary(`**Warning:** ${line}`);
  },
  // env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
  target: deployTargetLabel(process.env.WRANGLER_ENV),
};

let result;
try {
  result = await runGradualDeploy(ops);
} catch (err) {
  // runGradualDeploy catches its own throws; this is the last line, so nothing escapes
  // as an unhandled rejection with no annotation. The settle step then decides from
  // what the run recorded.
  const why = err instanceof Error ? err.message : String(err);
  result = {
    exit: EXIT.scriptFailed,
    end: "unknown" as const,
    message: `The deploy script itself failed (${why}). The settle step reads what this run recorded and ends any split it left.`,
  };
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
