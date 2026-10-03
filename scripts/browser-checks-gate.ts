/**
 * The CI step that decides whether the browser leg runs (#3079, #3100).
 *
 * The decision lives in scripts/lib/browser-checks-gate.ts, which has its own
 * suite; this file gathers the diff, reports, and writes `decision=run|skip` to
 * GITHUB_OUTPUT. A skip carries a ::notice:: and a step summary saying why, so a
 * leg that passed without building never reads as one that built and passed.
 *
 * Runs on bare node with --experimental-strip-types and imports nothing outside
 * node built ins and scripts/lib. Needs `fetch-depth: 2` on the checkout, so the
 * pull request's merge commit has both parents.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { changedFilesFromMergeCommit, workflowCommandText } from "./lib/migration-drift-gate.ts";
import { decideBrowserGate } from "./lib/browser-checks-gate.ts";

const env = process.env;
const eventName = env.EVENT_NAME ?? "";
const changedFiles = changedFilesFromMergeCommit((args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
);
const decision = decideBrowserGate({ eventName, changedFiles });

console.log(workflowCommandText(`browser checks gate: ${decision.action} (event ${eventName || "unknown"})`));
for (const f of decision.touched.slice(0, 20)) console.log(`  input changed: ${workflowCommandText(f)}`);

if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `decision=${decision.action}\n`);
const heading = decision.action === "run" ? "Browser checks: running" : "Browser checks: nothing to check";
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${heading}\n\n${decision.reason}\n`);
if (decision.action === "skip") console.log(`::notice title=${heading}::${workflowCommandText(decision.reason)}`);
else console.log(workflowCommandText(decision.reason));
