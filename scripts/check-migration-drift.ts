/**
 * The CI gate: are all committed migrations applied on the remote (#482, #766, #1433)?
 *
 * The IO half. The decision lives in scripts/lib/migration-drift.ts with its own
 * suite, because a rule inside a workflow `run:` block is a rule nothing can test,
 * and this gate has now been rewritten twice for passing green having checked
 * nothing.
 *
 * Reads the CLI's output on stdin, so the workflow keeps ownership of `supabase
 * link` and the pipeline's own failure handling (`set -o pipefail`).
 *
 * Exit 0 = applied. Exit 1 = drifted, OR unreadable. Those two are told apart in
 * the message, never in the exit code: an output this could not read is not a
 * database it just checked.
 */
import { migrationDriftVerdict } from "./lib/migration-drift.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const verdict = migrationDriftVerdict(Buffer.concat(chunks).toString("utf8"));

if (verdict.ok) {
  console.log(`migration-drift: ${verdict.reason}`);
  process.exit(0);
}
console.log(`::error::migration-drift: ${verdict.reason}`);
process.exit(1);
