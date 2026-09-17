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
import { parseLock } from "./lib/migration-content.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CliResult,
  cliResultFromExec,
  readMigrationListWithRetry,
} from "./lib/migration-drift-cli.ts";

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
        // The exited-versus-never-ran decision lives in the tested module, because
        // a non-numeric `error.code` coerced into a status is NaN, and NaN compares
        // false against every check downstream (L50).
        const outcome = cliResultFromExec(error, stdout, stderr);
        if (outcome.ran) resolve(outcome.result);
        else reject(new Error(outcome.reason));
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

// The content lock, so this gate can also insist an INTENTION has become a fact
// (#1642). It is the only check that reads the remote, so it is the only one that can
// see a migration applied while the lock still says pending.
//
// A lock this cannot read is passed as undefined, not as an empty list: an empty list
// says "nothing is pending", which is an answer, and this learned nothing. The rest of
// the gate still runs, and the unreadable lock is reported rather than swallowed.
let lock;
try {
  lock = parseLock(
    readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", "applied-content.lock"), "utf8"),
  );
} catch (err) {
  lock = undefined;
  console.log(
    `migration-drift: could not read the content lock, so pending entries were not checked: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}

const verdict = migrationDriftVerdict(read.output, lock);
if (verdict.ok) {
  console.log(
    `migration-drift: ${verdict.reason}` +
      (read.attempts > 1 ? ` (read on attempt ${read.attempts})` : ""),
  );
  process.exit(0);
}
console.log(`::error::migration-drift: ${verdict.reason}`);
process.exit(1);
