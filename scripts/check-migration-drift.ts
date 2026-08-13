/**
 * The CI gate: are all committed migrations applied on the remote (#482, #766,
 * #1433, #1437)?
 *
 * The IO half. Two decisions live in modules with their own suites, because a rule
 * inside a workflow `run:` block is a rule nothing can test and this gate has now
 * been rewritten three times:
 *
 *   - scripts/lib/migration-drift-cli.ts  obtaining the CLI's answer, with the
 *     bounded retry from #1437, and the line between "could not answer" (retry)
 *     and "answered" (never retry).
 *   - scripts/lib/migration-drift.ts      judging that answer.
 *
 * This file owns only the spawn, the log, and the exit code.
 *
 * Exit 0 = applied. Exit 1 = drifted, OR unreadable, OR the CLI never answered.
 * Those are told apart in the message, never in the exit code: an output this
 * could not read is not a database it just checked.
 */
import { execFile } from "node:child_process";
import { migrationDriftVerdict } from "./lib/migration-drift.ts";
import { type CliResult, readMigrationListWithRetry } from "./lib/migration-drift-cli.ts";

const refFlag = process.argv.indexOf("--project-ref");
const projectRef = refFlag === -1 ? "" : (process.argv[refFlag + 1] ?? "");
if (!projectRef) {
  console.log("::error::migration-drift: --project-ref <ref> is required.");
  process.exit(1);
}

/** Per command ceiling. A hung CLI must fail the step, never hold the runner (L110). */
const CLI_TIMEOUT_MS = 120_000;

function runSupabase(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "supabase",
      args,
      {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // stdin is deliberately not inherited: if the CLI ever decides to prompt
        // (for a DB password it could not read from the env), it must fail rather
        // than wait forever for an answer no CI runner can give.
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A numeric `code` is a real exit status. Anything else (an ENOENT string,
        // or null after the timeout killed it) means it never ran to completion, so
        // it is reported as such rather than coerced into a status: `Number("ENOENT")`
        // is NaN, and NaN compares false against every check downstream (L50).
        if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
      },
    );
    child.stdin?.end();
  });
}

const read = await readMigrationListWithRetry({
  projectRef,
  run: runSupabase,
  onRetry: ({ attempt, reason, waitMs }) => {
    // Visible in the log, so an occasional slow run explains itself and a pattern
    // of retries is something a reader can notice rather than infer.
    console.log(
      `::warning::migration-drift: attempt ${attempt} could not read the CLI ` +
        `(${reason}). Retrying in ${Math.round(waitMs / 1000)}s.`,
    );
  },
});

if (!read.ok) {
  console.log(
    `::error::migration-drift: the Supabase CLI never answered, so nothing was ` +
      `checked. ${read.reason}. This is not an applied database.`,
  );
  process.exit(1);
}

// Replaces the old `tee`: the table still shows up in the CI log, which is where
// anyone diagnosing a drift finding looks first.
console.log(read.output);

const verdict = migrationDriftVerdict(read.output);
if (verdict.ok) {
  console.log(
    `migration-drift: ${verdict.reason}` +
      (read.attempts > 1 ? ` (read on attempt ${read.attempts})` : ""),
  );
  process.exit(0);
}
console.log(`::error::migration-drift: ${verdict.reason}`);
process.exit(1);
