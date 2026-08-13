/**
 * The server-side merge-gap backstop's IO half (#113, #1436).
 *
 * Invoked by .github/workflows/merge-gap.yml on every push to a non-main branch.
 * Reads the branch's pull requests and applies the verdict from
 * scripts/lib/merge-gap.ts, which has its own suite.
 *
 * Why this is a script and not four lines of YAML: the decision it makes turns on
 * telling "no pull request" apart from "could not ask about pull requests", and
 * inside a `run:` block those were the same empty string. This guard exists to
 * catch a stranded commit, and it was reporting green whenever GitHub had a bad
 * minute.
 *
 * The gh read gets a bounded retry (the same helper the migration drift gate uses),
 * because a single API blip failing this job would teach people to re-run it
 * reflexively, which is how a real finding gets re-run too. Exhausting the attempts
 * is still a hard failure.
 *
 * Exit 0 = safe to push here. Exit 1 = it strands, OR the guard could not tell.
 * Those two are told apart in the message, never in the exit code.
 */
import { execFile } from "node:child_process";
import { mergeGapVerdict, type PrStateRead } from "./lib/merge-gap.ts";
import { retryTransient } from "./lib/retry.ts";

const branch = (process.env.BRANCH ?? "").trim();
const repo = (process.env.REPO ?? "").trim();
if (!branch || !repo) {
  console.log("::error::merge-gap: BRANCH and REPO must both be set.");
  process.exit(1);
}

/** A hung `gh` must fail the step, never hold the runner (L110). */
const GH_TIMEOUT_MS = 60_000;

function runGh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A numeric code is a real exit status. A string ("ENOENT") or null (killed
        // on the timeout) means it never ran, and coercing either into a status
        // would give NaN, which compares false against every check (L50).
        if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(new Error(`${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      },
    );
    child.stdin?.end();
  });
}

const attempt = await retryTransient<string>({
  attempts: 3,
  onRetry: ({ attempt: n, reason, waitMs }) => {
    console.log(
      `::warning::merge-gap: attempt ${n} could not read the pull requests (${reason}). ` +
        `Retrying in ${Math.round(waitMs / 1000)}s.`,
    );
  },
  run: async () => {
    let result: Awaited<ReturnType<typeof runGh>>;
    try {
      result = await runGh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "state",
        "--jq",
        ".[].state",
      ]);
    } catch (e) {
      return { ok: false, reason: `gh could not run: ${String(e)}` };
    }
    if (result.code !== 0) {
      const said = (result.stderr.trim() || result.stdout.trim() || "(no output)").split("\n")[0];
      return { ok: false, reason: `gh pr list exited ${result.code}: ${said}` };
    }
    // Exit 0 with NO output is a real answer: this branch has no pull requests.
    return { ok: true, value: result.stdout };
  },
});

const read: PrStateRead = attempt.ok
  ? { ok: true, states: attempt.value.split("\n") }
  : { ok: false, reason: attempt.reason };

const verdict = mergeGapVerdict(read, branch);
if (verdict.ok) {
  console.log(`merge-gap: ${verdict.reason}.`);
  process.exit(0);
}
// Both failures go red, and the annotation says WHICH: one is the person's to fix,
// the other is a re-run.
const title = verdict.unverified ? "merge-gap could not verify" : "This push strands";
console.log(`::error title=${title}::merge-gap: ${verdict.reason}`);
process.exit(1);
