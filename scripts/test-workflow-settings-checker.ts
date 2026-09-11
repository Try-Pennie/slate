// The workflow-settings checker's own behaviour (#1500).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-workflow-settings-checker.ts
//
// `scripts/check-workflow-settings.ts` asks GitHub, so its DECISIONS are what
// have to be pinned rather than its answer on any given day. The one that
// matters most is the one a checker gets wrong quietly: a listing that FAILED
// and a repo with no settings look identical downstream, and the second reads as
// a real finding while the first means nothing was checked at all (L98).
//
// Driven through a fake `gh` on PATH, so the real script runs end to end,
// including its argument construction. A stub whose pattern never matched would
// leave the script talking to the real GitHub and reporting whatever that says,
// so each case asserts on output only the stub can produce (L141).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

/** Every setting the real workflows reference today, so the happy path is real. */
const REAL_VARS = [
  "EXPECT_HTTPS_REDIRECT",
  // The load run's isolated deployment (#2244). It is `workflow_dispatch` only and
  // every script it runs refuses an empty value BY NAME, so a repo that has not set
  // these up cannot dispatch a misconfigured run; they are listed here because this
  // case asserts that a repo where every referenced setting DOES exist passes.
  "LOADTEST_BASE_URL",
  "LOADTEST_WORKER_NAME",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SLACK_ALERTS_CHANNEL",
  "SLATE_BASE_URL",
];
const REAL_SECRETS = [
  "BOOKING_API_KEY",
  "CALCOM_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "LOADTEST_BOOKING_API_KEY",
  "LOADTEST_CRON_SECRET",
  "LOADTEST_SUPABASE_SECRET_KEY",
  "LOADTEST_SUPABASE_URL",
  "REASSIGN_API_KEY",
  "SLACK_BOT_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_SECRET_KEY",
  // Required by the daily cal.com parity lane since #2153, wired in #2218. This
  // list is what a FULLY CONFIGURED repo holds; whether the repo really holds them
  // is the live `pnpm check:workflow-settings` run in the pre-push hook, which is
  // the half of this pair that can see reality.
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_WORKSPACE_SID",
];

interface Run {
  code: number;
  out: string;
}

/**
 * Run the checker with a fake `gh` first on PATH.
 *
 * `ghScript` null means gh is ABSENT entirely, which is its own case: a checker
 * that treats a missing tool as "nothing to report" is the same defect as one
 * that treats a failed listing that way.
 */
function runChecker(ghScript: string | null): Run {
  const dir = mkdtempSync(join(tmpdir(), "wf-settings-"));
  try {
    if (ghScript !== null) {
      const gh = join(dir, "gh");
      writeFileSync(gh, ghScript);
      chmodSync(gh, 0o755);
    }
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          "./scripts/register-paths.mjs",
          "scripts/check-workflow-settings.ts",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          // PATH is REPLACED, not prepended, when gh must be absent: a stray gh
          // elsewhere on the real PATH would silently answer for the stub.
          env: { ...process.env, PATH: ghScript === null ? dir : `${dir}:${process.env.PATH}` },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stub = (vars: string[], secrets: string[]) =>
  `#!/bin/sh\ncase "$1" in\n  variable) printf '%s\\n' ${vars.map((v) => `'${v}'`).join(" ") || "''"} ;;\n  secret) printf '%s\\n' ${secrets.map((s) => `'${s}'`).join(" ") || "''"} ;;\nesac\n`;

// --- every referenced setting exists -------------------------------------------
{
  const r = runChecker(stub(REAL_VARS, REAL_SECRETS));
  assert(r.code === 0, `a fully configured repo passes (exit ${r.code}: ${r.out})`);
  assert(
    /all \d+ referenced repo settings exist/.test(r.out),
    `and says how many it checked (got ${r.out.trim()})`,
  );
  // Proof the stub was actually reached: these counts come only from it.
  assert(
    r.out.includes(`${REAL_VARS.length} variables`) &&
      r.out.includes(`${REAL_SECRETS.length} secrets`),
    `the counts come from the stub, so the script really talked to it (got ${r.out.trim()})`,
  );
}

// --- one is missing ------------------------------------------------------------
{
  const r = runChecker(stub(REAL_VARS.filter((v) => v !== "SLATE_BASE_URL"), REAL_SECRETS));
  assert(r.code !== 0, "a reference with no setting behind it fails");
  assert(r.out.includes("vars.SLATE_BASE_URL"), `and names it (got ${r.out.trim()})`);
  assert(
    r.out.includes("smoke-canary.yml"),
    "and names the workflow that references it, so it is findable",
  );
  assert(
    r.out.includes("gh variable set SLATE_BASE_URL"),
    "and gives the command that fixes it, rather than only the complaint",
  );
  assert(
    /EMPTY STRING/.test(r.out),
    "and says WHY it matters, since GitHub reports no error of its own",
  );
}

// --- a missing SECRET is named as a secret, not a variable ----------------------
{
  const r = runChecker(stub(REAL_VARS, REAL_SECRETS.filter((s) => s !== "BOOKING_API_KEY")));
  assert(r.code !== 0, "a missing secret fails too");
  assert(r.out.includes("secrets.BOOKING_API_KEY"), "named as a secret");
  assert(
    r.out.includes("gh secret set BOOKING_API_KEY") && !r.out.includes("gh variable set BOOKING_API_KEY"),
    "and repaired with the secret command, since the two are different settings",
  );
}

// --- the listing FAILED: nothing was checked, and that is not a pass ------------
//
// The case this test exists for. An empty list and an unauthenticated `gh` are
// indistinguishable to the comparison, and the failure has to be its own outcome
// or a permissions problem reads as a clean repo.
{
  const r = runChecker("#!/bin/sh\necho 'gh: not authenticated' >&2\nexit 1\n");
  assert(r.code !== 0, "a failed listing does not pass");
  assert(
    /NOTHING was checked/i.test(r.out),
    `and says nothing was checked, not that nothing was wrong (got ${r.out.trim()})`,
  );
  assert(
    /token/i.test(r.out),
    "and names what it needs, since this is the expected failure in CI",
  );
  assert(
    !/all \d+ referenced repo settings exist/.test(r.out),
    "and never claims a clean result off a listing it could not read",
  );
}

// --- gh is absent entirely -----------------------------------------------------
{
  const r = runChecker(null);
  assert(r.code !== 0, "a missing gh does not pass either");
  assert(/gh is not installed/i.test(r.out), `and says so plainly (got ${r.out.trim()})`);
}

// --- an EMPTY repo: every reference is missing, and none is silently waved through
{
  const r = runChecker(stub([], []));
  assert(r.code !== 0, "a repo with no settings at all fails");
  assert(
    (r.out.match(/referenced in/g) ?? []).length >= 5,
    `and reports every reference, not just the first (got ${r.out.trim()})`,
  );
}

finish();
