// Roll production back, then prove what is serving (#3094).
//
// Run by .github/workflows/rollback.yml (workflow_dispatch), and by hand as
// `pnpm cf:rollback`. It picks the target (the newest version that served 100% on its
// own, or the one named), refuses a gradual deploy canary, runs `wrangler rollback`,
// and then runs the SAME probe the deploy uses against the commit the target was tagged
// with. Every decision is in scripts/lib/rollback-plan.ts and pinned offline by
// scripts/test-rollback-plan.ts; this file is only I/O.
//
// It writes its ending to ROLLBACK_SUMMARY_FILE (when set) so the alert step can say
// what happened whatever this process's exit code was.
//
// env: CLOUDFLARE_API_TOKEN (read by wrangler), BOOKING_API_KEY_CANARY,
//      ROLLBACK_VERSION_ID (optional), ROLLBACK_EXPECTED_COMMIT (optional),
//      ROLLBACK_REASON, APP_URL, WRANGLER_ENV (the load test rehearsal only).
import { appendFileSync, writeFileSync } from "node:fs";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_VERSION_TIMEOUT_MS, runProbe } from "./lib/post-deploy-probe.ts";
import { httpProbeDeps } from "./lib/post-deploy-probe-http.ts";
import { CONFIRMATIONS } from "./lib/gradual-deploy.ts";
import { ROLLBACK_EXIT, runRollback, type RollbackOps } from "./lib/rollback-plan.ts";
import { envArgs, jsonPart, runCapture, runLoud } from "./lib/wrangler-cli.ts";

// env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
const wranglerEnv = envArgs(process.env.WRANGLER_ENV);
const key = process.env.BOOKING_API_KEY_CANARY ?? "";
const appUrl = (process.env.APP_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
// env-ok: SMOKE_BUCKET (a local override only; CI wants the seeded SMOKE bucket)
const bucket = process.env.SMOKE_BUCKET ?? "SMOKE";
// One line, no control characters: it becomes a deployment message.
// env-ok: ROLLBACK_REASON (the dispatch input; a hand run may omit it)
const reason = (process.env.ROLLBACK_REASON ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || "manual rollback";

function finishWith(exit: number, message: string): never {
  // env-ok: ROLLBACK_SUMMARY_FILE (an internal handoff between two steps of one job)
  const file = process.env.ROLLBACK_SUMMARY_FILE;
  if (file) writeFileSync(file, JSON.stringify({ exit, message }), "utf8");
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `**Rollback:** ${message}\n`, "utf8");
  if (exit === ROLLBACK_EXIT.rolledBack) console.log(`\n  ${message}\n`);
  else console.error(`::error title=rollback (exit ${exit})::${message}`);
  process.exit(exit);
}

if (!key) {
  finishWith(
    ROLLBACK_EXIT.unreadable,
    "Not rolled back: BOOKING_API_KEY_CANARY is unset, so the rolled back version could not be confirmed. Nothing changed.",
  );
}

const ops: RollbackOps = {
  list: async () => jsonPart(runCapture("pnpm", ["exec", "wrangler", "deployments", "list", "--json", ...wranglerEnv])),
  view: async (id) => jsonPart(runCapture("pnpm", ["exec", "wrangler", "versions", "view", id, "--json", ...wranglerEnv])),
  rollback: async (id) => runLoud("pnpm", ["exec", "wrangler", "rollback", id, "-y", "--message", reason, ...wranglerEnv]),
  probe: async (expectedCommit) =>
    runProbe(httpProbeDeps({ appUrl, key, bucket, versionOverride: null }), {
      expectedCommit,
      versionTimeoutMs: DEFAULT_VERSION_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      confirmations: CONFIRMATIONS,
    }),
  log: (line) => console.log(`  ${line}`),
};

const result = await runRollback(ops, {
  // env-ok: ROLLBACK_VERSION_ID (the dispatch input; empty means the newest known good)
  requestedVersionId: process.env.ROLLBACK_VERSION_ID ?? "",
  // env-ok: ROLLBACK_EXPECTED_COMMIT (the dispatch input, for a target with no tag)
  expectedCommit: process.env.ROLLBACK_EXPECTED_COMMIT ?? "",
});
finishWith(result.exit, result.message);
