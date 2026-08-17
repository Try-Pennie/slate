/**
 * #1519: the main-push guard's association read must survive a momentary GitHub
 * blip instead of going blind on it.
 *
 * On 2026-08-17 `GET /repos/<repo>/commits/<sha>/pulls` answered
 * `403 Resource not accessible by integration` at 13:59 and again at 14:02, and
 * answered 200 from a job carrying the guard's exact permissions at 14:28.
 * Nothing was misconfigured. One shot at the endpoint turned that blip into a
 * failed run and a Slack page on the only control standing in for branch
 * protection, and a false page there is worse than none, because it is the alert
 * everybody learns to ignore (L36, L77).
 *
 * The read lives in `scripts/lib/read-commit-pulls.sh` rather than inline in the
 * workflow for the same reason the workflow-settings guard does: so the decision
 * can be driven by a test with a fake `gh` on PATH, with no remote and no push to
 * main.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-commit-pulls-retry.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPT = join(process.cwd(), "scripts/lib/read-commit-pulls.sh");

/**
 * Run the read with a fake `gh` whose behaviour is scripted per attempt.
 *
 * `plan` is one entry per call: either a body to print with exit 0, or an object
 * carrying the body and a non-zero exit. The fake counts its own calls into a
 * file so the test can assert HOW MANY attempts really happened, rather than
 * inferring it from the outcome.
 */
function runWith(plan: ({ body: string; exit?: number } | string)[]) {
  const dir = mkdtempSync(join(tmpdir(), "commit-pulls-"));
  const countFile = join(dir, "calls");
  writeFileSync(countFile, "0");
  const cases = plan.map((p) => (typeof p === "string" ? { body: p, exit: 0 } : { exit: 0, ...p }));

  const gh = `#!/usr/bin/env bash
n=$(cat ${countFile})
n=$((n + 1))
echo "$n" > ${countFile}
case "$n" in
${cases
  .map((c, i) => `  ${i + 1}) cat <<'EOF'\n${c.body}\nEOF\n     exit ${c.exit};;`)
  .join("\n")}
  *) echo 'ran out of scripted responses'; exit 99;;
esac
`;
  writeFileSync(join(dir, "gh"), gh);
  chmodSync(join(dir, "gh"), 0o755);

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", [SCRIPT, "owner/repo", "deadbeef"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // Keeps the suite fast; the real workflow leaves it unset and backs off.
        COMMIT_PULLS_RETRY_SLEEP: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    status = e.status ?? 1;
    stdout = e.stdout ?? "";
  }
  return { stdout: stdout.trim(), status, calls: Number(readFileSync(countFile, "utf8").trim()) };
}

const OK_BODY = '[{"number":1518,"merged_at":"2026-08-17T13:59:54Z"}]';
const FORBIDDEN = '{"message":"Resource not accessible by integration","status":"403"}';

// ---------------------------------------------------- the control

// Without this every other assertion here is satisfied by a script that can only
// ever fail (L1).
{
  const r = runWith([OK_BODY]);
  eq(r.status, 0, "a first-attempt success exits zero");
  eq(r.calls, 1, "and costs exactly one request, so the common path is not slowed");
  assert(r.stdout.includes("1518"), "and prints the association body through");
}

// ---------------------------------------------------- the blip

// The case that filed the issue: it fails, then fails, then works.
{
  const r = runWith([{ body: FORBIDDEN, exit: 1 }, { body: FORBIDDEN, exit: 1 }, OK_BODY]);
  eq(r.status, 0, "a read that recovers on the third attempt SUCCEEDS");
  eq(r.calls, 3, "having really retried rather than reported the first answer");
  assert(r.stdout.includes("1518"), "and yields the good body, not the error one");
}

{
  const r = runWith([{ body: FORBIDDEN, exit: 1 }, OK_BODY]);
  eq(r.status, 0, "a single blip is absorbed");
  eq(r.calls, 2, "on the second attempt");
}

// ---------------------------------------------------- still fails closed

// A retry must not become a way of eventually passing. When every attempt fails
// the read is still UNREADABLE, and the guard still refuses to vouch for the push.
{
  const r = runWith([
    { body: FORBIDDEN, exit: 1 },
    { body: FORBIDDEN, exit: 1 },
    { body: FORBIDDEN, exit: 1 },
  ]);
  assert(r.status !== 0, "a read that never succeeds still fails");
  eq(r.calls, 3, "after a bounded number of attempts, so the guard cannot hang (L110)");
  assert(!r.stdout.includes("Resource not accessible"), "and never prints the error body as data");
}

// ---------------------------------------------------- the success predicate

// L156: the answer is judged by the SHAPE of a good response, never by a
// substring of what was asked for. An error body quotes its own target, so a
// check looking for the repo or the endpoint in the output would accept the
// failure and stop retrying on the very first one.
{
  // A 200 whose body is an OBJECT, not an array: gh exits zero and the content is
  // unusable. This is the shape a rate-limit or an error envelope arrives in.
  const r = runWith([{ body: FORBIDDEN, exit: 0 }, { body: FORBIDDEN, exit: 0 }, OK_BODY]);
  eq(r.status, 0, "a zero-exit response that is not an array is retried, not accepted");
  eq(r.calls, 3, "so a soft failure costs the same retries a hard one does");
  assert(r.stdout.includes("1518"), "and the array that finally arrives is what is returned");
}

{
  const r = runWith([{ body: "owner/repo not found", exit: 0 }, "[]"]);
  eq(r.status, 0, "unparseable output is retried");
  eq(r.stdout, "[]", "and an EMPTY array is a real answer, kept as-is rather than retried");
  eq(r.calls, 2, "an empty association is success: it means no PR, which the classifier judges");
}

finish();
