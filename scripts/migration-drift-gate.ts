/**
 * The CI step that decides whether the migration drift check runs (#3051).
 *
 * The decision lives in scripts/lib/migration-drift-gate.ts, which has its own
 * suite; this file only gathers the inputs, reports, and sets the exit code.
 *
 *   run    -> exit 0, `decision=run` on GITHUB_OUTPUT, the drift steps run.
 *   skip   -> exit 0, `decision=skip`, a ::notice:: annotation AND a step summary
 *             saying why, so a Dependabot pull request never passes silently.
 *   refuse -> exit 1 with an ::error:: annotation and the same summary.
 *
 * Runs on bare node with --experimental-strip-types and imports nothing outside
 * node built ins and scripts/lib, so it works even when the install step failed.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  changedFilesFromMergeCommit,
  decideMigrationDriftGate,
  isDependabotPullRequest,
  workflowCommandText,
} from "./lib/migration-drift-gate.ts";

const env = process.env;
const eventName = env.EVENT_NAME ?? "";
const headRef = env.HEAD_REF ?? "";
const actor = env.ACTOR ?? "";
// Only presence is read. The values never reach a log line.
const secretsPresent = (env.SUPABASE_ACCESS_TOKEN ?? "") !== "" && (env.SUPABASE_DB_PASSWORD ?? "") !== "";

// The diff is only consulted when it could change the answer, so a normal run
// never depends on git history it did not need.
const changedFiles =
  !secretsPresent && isDependabotPullRequest({ eventName, headRef, actor })
    ? changedFilesFromMergeCommit((args) =>
        execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      )
    : null;

const decision = decideMigrationDriftGate({ eventName, headRef, actor, changedFiles, secretsPresent });

console.log(
  workflowCommandText(
    `migration-drift gate: ${decision.action} (event ${eventName || "unknown"}, head ref ${headRef || "none"}, actor ${actor || "unknown"})`,
  ),
);
if (changedFiles !== null) {
  console.log(`changed files (${changedFiles.length}):`);
  for (const f of changedFiles) console.log(`  ${workflowCommandText(f)}`);
}

if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `decision=${decision.action}\n`);

const heading =
  decision.action === "run"
    ? "Migration drift check: running"
    : decision.action === "skip"
      ? "Migration drift check: skipped"
      : "Migration drift check: refused";
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${heading}\n\n${decision.reason}\n`);

if (decision.action === "refuse") {
  console.log(`::error title=${heading}::${workflowCommandText(decision.reason)}`);
  process.exit(1);
}
if (decision.action === "skip") console.log(`::notice title=${heading}::${workflowCommandText(decision.reason)}`);
else console.log(workflowCommandText(decision.reason));
