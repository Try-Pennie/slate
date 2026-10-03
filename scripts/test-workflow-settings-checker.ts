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
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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
  // #2822: the canary's own key, which every canary lane now sends instead of the shared one.
  "BOOKING_API_KEY_CANARY",
  "CALCOM_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "LOADTEST_BOOKING_API_KEY",
  "LOADTEST_CRON_SECRET",
  // The fault leg REBUILDS the deployment (#2262), and the publishable key is
  // inlined at build time, so it is a build input the workflow needs rather than a
  // runtime one the deployment already holds.
  "LOADTEST_SUPABASE_PUBLISHABLE_KEY",
  "LOADTEST_SUPABASE_SECRET_KEY",
  "LOADTEST_SUPABASE_URL",
  // The daily off platform database dump (#3076). Listed because this is what a
  // FULLY CONFIGURED repo holds; until they are created, the live check in the
  // pre-push hook is what says they are missing.
  "R2_BACKUP_ACCESS_KEY_ID",
  "R2_BACKUP_BUCKET",
  "R2_BACKUP_ENDPOINT",
  "R2_BACKUP_SECRET_ACCESS_KEY",
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
 *
 * `workflows` points the checker at a fixture tree instead of the repo's own
 * `.github/workflows`, which is how the per-run declaration's GRAMMAR is driven
 * (a declaration with no reason, one naming a setting nothing references) without
 * committing a broken workflow to the repo to prove the guard catches it.
 */
function runChecker(ghScript: string | null, workflows?: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "wf-settings-"));
  try {
    if (ghScript !== null) {
      const gh = join(dir, "gh");
      writeFileSync(gh, ghScript);
      chmodSync(gh, 0o755);
    }
    let workflowDir: string | undefined;
    if (workflows) {
      workflowDir = mkdtempSync(join(tmpdir(), "wf-fixtures-"));
      for (const [name, body] of Object.entries(workflows)) {
        writeFileSync(join(workflowDir, name), body);
      }
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
          env: {
            ...process.env,
            PATH: ghScript === null ? dir : `${dir}:${process.env.PATH}`,
            ...(workflowDir ? { WORKFLOW_SETTINGS_DIR: workflowDir } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    } finally {
      if (workflowDir) rmSync(workflowDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A workflow that references one var and one secret, with no declaration. */
const PLAIN_WORKFLOW = [
  "name: Plain",
  "on: push",
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: node scripts/noop.ts",
  "        env:",
  "          BASE: ${{ vars.SLATE_BASE_URL }}",
  "          KEY: ${{ secrets.BOOKING_API_KEY }}",
  "",
].join("\n");

/**
 * What the stub answers for the ORGANISATION listing (#2342).
 *
 * `available` with empty lists is the default, which is a real organisation that
 * simply defines nothing: it leaves every earlier case judging exactly what it
 * judged before this scope existed. `refused` is the state measured on 2026-09-14,
 * where the local token answers 403 for the org while the repo listing answers
 * happily.
 */
type OrgStub =
  | { kind: "empty" }
  | { kind: "holds"; vars?: [string, number][]; secrets?: [string, number][] }
  | { kind: "refused"; message: string }
  | { kind: "no-such-org" }
  | { kind: "no-owner" };

const orgJson = (rows: [string, number][] = []) =>
  JSON.stringify(rows.map(([name, numSelectedRepos]) => ({ name, numSelectedRepos })));

/**
 * `$1` is gh's first argument, so `repo view`, `variable list` and `secret list`
 * are told apart by it, and the ORG listing is told from the REPO one by the
 * `--org` flag anywhere in the argument list. A stub that answered both the same
 * way would leave the org call reading the repo's own settings and prove nothing.
 */
function orgArm(kind: "variable" | "secret", org: OrgStub): string {
  switch (org.kind) {
    case "empty":
      return `printf '%s\\n' '[]'`;
    case "holds":
      return `printf '%s\\n' '${orgJson(kind === "variable" ? org.vars : org.secrets)}'`;
    case "refused":
      return `printf '%s\\n' '${org.message}' >&2; exit 1`;
    case "no-such-org":
      return `printf '%s\\n' 'gh: Not Found (HTTP 404)' >&2; exit 1`;
    case "no-owner":
      return `printf '%s\\n' '[]'`;
  }
}

const stub = (vars: string[], secrets: string[], org: OrgStub = { kind: "empty" }) => {
  const arm = (kind: "variable" | "secret", names: string[]) =>
    `  ${kind}) case "$*" in\n    *--org*) ${orgArm(kind, org)} ;;\n    *) printf '%s\\n' ${
      names.map((n) => `'${n}'`).join(" ") || "''"
    } ;;\n  esac ;;\n`;
  const owner =
    org.kind === "no-owner"
      ? `  repo) printf '%s\\n' '' ;;\n`
      : `  repo) printf '%s\\n' 'Try-Pennie' ;;\n`;
  return `#!/bin/sh\ncase "$1" in\n${owner}${arm("variable", vars)}${arm("secret", secrets)}esac\n`;
};

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
  const r = runChecker(stub(REAL_VARS, REAL_SECRETS.filter((s) => s !== "BOOKING_API_KEY_CANARY")));
  assert(r.code !== 0, "a missing secret fails too");
  assert(r.out.includes("secrets.BOOKING_API_KEY_CANARY"), "named as a secret");
  assert(
    r.out.includes("gh secret set BOOKING_API_KEY_CANARY") && !r.out.includes("gh variable set BOOKING_API_KEY_CANARY"),
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

// --- settings PROVISIONED PER RUN (#2293) --------------------------------------
//
// The load run's seven settings are created by the dispatcher and deleted by the
// teardown job, so between runs they genuinely do not exist. Failing on that made
// every push touching ANY workflow reach for SKIP_WORKFLOW_SETTINGS_CHECK=1, which
// is a guard whose routine remedy is to override it (L36) and which waves a real
// missing setting on another workflow through in the same breath.

/** The load run's own seven, which the real `loadtest.yml` declares. */
const PER_RUN = [
  "LOADTEST_BASE_URL",
  "LOADTEST_WORKER_NAME",
  "LOADTEST_BOOKING_API_KEY",
  "LOADTEST_CRON_SECRET",
  "LOADTEST_SUPABASE_URL",
  "LOADTEST_SUPABASE_SECRET_KEY",
  "LOADTEST_SUPABASE_PUBLISHABLE_KEY",
];

// The real tree, with the seven genuinely absent: the state the repo is in between
// load runs, and the one that used to block every push.
{
  const r = runChecker(
    stub(
      REAL_VARS.filter((v) => !PER_RUN.includes(v)),
      REAL_SECRETS.filter((s) => !PER_RUN.includes(s)),
    ),
  );
  assert(r.code === 0, `the seven being absent does not block a push (exit ${r.code}: ${r.out})`);
  assert(
    /not judged/i.test(r.out),
    `and the run SAYS they were not judged (got ${r.out.trim()})`,
  );
  for (const name of PER_RUN) {
    assert(r.out.includes(name), `and names ${name}, so the narrowing is visible`);
  }
  assert(
    /provisioned/i.test(r.out) && /teardown|between runs/i.test(r.out),
    `and gives the declared REASON rather than only the fact (got ${r.out.trim()})`,
  );
  // The positive control: a run that parsed no workflow at all reports the same
  // absence of findings as a clean one (L98), so the count examined must be real.
  const examined = r.out.match(/(\d+) referenced repo setting/);
  assert(
    examined !== null && Number(examined[1]) >= 20,
    `and says how many references it examined, which a scan that read nothing cannot (got ${r.out.trim()})`,
  );
}

// A per-run setting that DOES exist is judged normally, not skipped. That is the
// difference between "absent is allowed" and "these are never checked".
{
  const r = runChecker(stub(REAL_VARS, REAL_SECRETS));
  assert(r.code === 0, "every setting present still passes");
  assert(
    !/not judged/i.test(r.out),
    `and nothing is reported unjudged when nothing is absent (got ${r.out.trim()})`,
  );
  assert(
    /all \d+ referenced repo settings exist/.test(r.out),
    "so the seven count toward the settings that exist, like any other",
  );
}

// The control that stops this from being the guard switched off: a missing setting
// NOT declared per run still fails, and is still named.
{
  const r = runChecker(stub(REAL_VARS.filter((v) => v !== "SLATE_BASE_URL"), REAL_SECRETS));
  assert(r.code !== 0, "a missing setting nobody declared per run still fails");
  assert(r.out.includes("vars.SLATE_BASE_URL"), "and is still named");
}

// Both at once: the seven absent AND a real one missing. The real one decides.
{
  const r = runChecker(
    stub(
      REAL_VARS.filter((v) => !PER_RUN.includes(v) && v !== "SLATE_BASE_URL"),
      REAL_SECRETS.filter((s) => !PER_RUN.includes(s)),
    ),
  );
  assert(r.code !== 0, "a real missing setting fails even while seven are unjudged");
  assert(r.out.includes("vars.SLATE_BASE_URL"), "and is named");
  assert(
    /1 workflow reference\(s\) point at a repo setting that does not exist/.test(r.out),
    `and the per-run seven are not counted among the things to go and create (got ${r.out.trim()})`,
  );
  assert(
    /not judged/i.test(r.out),
    "and a failing run STILL says which references it never judged, so nobody reads it as having judged them all",
  );
}

// The declaration is scoped to the file that makes it: another workflow referencing
// the same name without declaring it is still a finding, because "provisioned per
// run" is a fact about that workflow's own dispatcher.
{
  const r = runChecker(stub([], []), {
    "a.yml": [
      "# settings-provisioned-per-run: LOADTEST_BASE_URL",
      "#   because the dispatcher creates it for one run and the teardown job",
      "#   deletes it afterwards, so between runs its absence is the normal state.",
      "name: A",
      "on: workflow_dispatch",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/noop.ts",
      "        env:",
      "          BASE: ${{ vars.LOADTEST_BASE_URL }}",
      "",
    ].join("\n"),
    "b.yml": [
      "name: B",
      "on: push",
      "jobs:",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/noop.ts",
      "        env:",
      "          BASE: ${{ vars.LOADTEST_BASE_URL }}",
      "",
    ].join("\n"),
  });
  assert(r.code !== 0, "a second workflow referencing it without declaring it fails");
  assert(r.out.includes("b.yml"), `and names that workflow (got ${r.out.trim()})`);
}

// A declaration carrying NO reason is refused. A marker whose reason is not itself
// checked is one somebody satisfies by writing nothing at all (L675, L233).
{
  const r = runChecker(stub([], []), {
    "a.yml": [
      "# settings-provisioned-per-run: LOADTEST_BASE_URL",
      "name: A",
      "on: workflow_dispatch",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/noop.ts",
      "        env:",
      "          BASE: ${{ vars.LOADTEST_BASE_URL }}",
      "",
    ].join("\n"),
  });
  assert(r.code !== 0, "a per-run declaration with no reason is refused");
  assert(
    /reason/i.test(r.out) && r.out.includes("a.yml"),
    `and says a reason is what is missing, in the file that owes it (got ${r.out.trim()})`,
  );
}

// The surrounding syntax must not satisfy the requirement either: the `because`
// keyword with nothing after it is no reason at all.
{
  const r = runChecker(stub([], []), {
    "a.yml": [
      "# settings-provisioned-per-run: LOADTEST_BASE_URL because",
      "name: A",
      "on: workflow_dispatch",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/noop.ts",
      "        env:",
      "          BASE: ${{ vars.LOADTEST_BASE_URL }}",
      "",
    ].join("\n"),
  });
  assert(r.code !== 0, "the keyword alone does not count as a reason");
}

// A declaration on a workflow that runs WITHOUT somebody dispatching it is refused.
// "Provisioned per run" means a person creates the settings before the run; a
// schedule or a push cannot, so every one of those runs would go out on empty
// strings, which is the #1495 failure the whole check exists for.
{
  const r = runChecker(stub([], []), {
    "a.yml": [
      "# settings-provisioned-per-run: LOADTEST_BASE_URL",
      "#   because the dispatcher creates it for one run and the teardown job",
      "#   deletes it afterwards, so between runs its absence is the normal state.",
      "name: A",
      "on:",
      "  schedule:",
      "    - cron: '*/30 * * * *'",
      "  workflow_dispatch:",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/noop.ts",
      "        env:",
      "          BASE: ${{ vars.LOADTEST_BASE_URL }}",
      "",
    ].join("\n"),
  });
  assert(r.code !== 0, "a per-run declaration on a scheduled workflow is refused");
  assert(
    /schedule/.test(r.out) && r.out.includes("a.yml"),
    `and names the trigger that makes it wrong (got ${r.out.trim()})`,
  );
}

// A declaration naming a setting the file never references is stale, and a stale
// exemption is the shape of one nobody re-read (L129).
{
  const r = runChecker(stub(["SLATE_BASE_URL"], ["BOOKING_API_KEY"]), {
    "a.yml": [
      "# settings-provisioned-per-run: LOADTEST_GONE",
      "#   because the dispatcher creates it for one run and the teardown job",
      "#   deletes it afterwards, so between runs its absence is the normal state.",
      PLAIN_WORKFLOW.replace("on: push", "on:\n  workflow_dispatch:"),
    ].join("\n"),
  });
  assert(r.code !== 0, "a declaration naming a setting the file never references fails");
  assert(
    r.out.includes("LOADTEST_GONE"),
    `and names the stale entry (got ${r.out.trim()})`,
  );
}

// And the fixture seam itself is proved to work in the ordinary direction, so a
// failure above can never be a fixture tree the checker silently ignored.
{
  const r = runChecker(stub(["SLATE_BASE_URL"], ["BOOKING_API_KEY"]), { "a.yml": PLAIN_WORKFLOW });
  assert(r.code === 0, `a fixture tree whose settings all exist passes (got ${r.out.trim()})`);
  assert(
    /all 2 referenced repo settings exist/.test(r.out),
    `and counts only the fixture's own references, so the seam really redirected the scan (got ${r.out.trim()})`,
  );
}

// --- settings defined on the ORGANISATION (#2342) ------------------------------
//
// `gh variable list` and `gh secret list` are repo scope only. A setting the
// organisation defines is usable by the workflow and invisible to that listing, so
// the check named seven correctly configured settings as missing on 2026-09-14 and
// refused the push. A guard whose routine remedy is to override it is one nobody
// reads the next time it is right (L36).

// The organisation holds it: configured after all, and the run passes.
{
  const r = runChecker(
    stub(["BOOKING_API_KEY"], ["BOOKING_API_KEY"], {
      kind: "holds",
      vars: [["SLATE_BASE_URL", 0]],
    }),
    { "a.yml": PLAIN_WORKFLOW },
  );
  assert(r.code === 0, `an org level variable satisfies the reference (got ${r.out.trim()})`);
  assert(
    !r.out.includes("vars.SLATE_BASE_URL"),
    `and is not reported missing (got ${r.out.trim()})`,
  );
}

// The state measured on 2026-09-14: the repo listing answers, the ORG listing is
// refused. The reference must not be reported as one that was checked and found
// missing, and the run must not block the push over a setting it never judged.
{
  const r = runChecker(
    stub([], [], { kind: "refused", message: "gh: Resource not accessible (HTTP 403)" }),
    { "a.yml": PLAIN_WORKFLOW },
  );
  assert(r.code === 0, `a refused org listing does not block the push (got ${r.out.trim()})`);
  assert(
    /could NOT be checked/.test(r.out),
    `and says the references were not checked (got ${r.out.trim()})`,
  );
  assert(
    r.out.includes("403"),
    `and quotes what the org listing said, so it is diagnosable (got ${r.out.trim()})`,
  );
  assert(
    !/point at a repo setting that does not exist/.test(r.out),
    "and never renders an unchecked reference as a missing one",
  );
  assert(
    !/all \d+ referenced repo settings exist/.test(r.out),
    "and never claims a clean result for references it could not judge",
  );
  assert(
    /0 of 2 referenced repo settings exist/.test(r.out),
    `and says how many it really judged (got ${r.out.trim()})`,
  );
}

// An org setting shared with a SELECTED list of repositories: the listing cannot
// say whether this repo is on it, so it is unchecked rather than present. Counting
// it as configured would wave through the exact reference that interpolates an
// empty string, which is the whole fault being guarded.
{
  const r = runChecker(
    stub([], [], { kind: "holds", vars: [["SLATE_BASE_URL", 4]], secrets: [["BOOKING_API_KEY", 0]] }),
    { "a.yml": PLAIN_WORKFLOW },
  );
  assert(r.code === 0, "a selected-repo org setting does not block the push");
  assert(
    /could NOT be checked/.test(r.out) && r.out.includes("vars.SLATE_BASE_URL"),
    `and is named as unchecked (got ${r.out.trim()})`,
  );
  assert(
    /4 selected/.test(r.out),
    `with the reason, so the reader knows what to look at (got ${r.out.trim()})`,
  );
  assert(
    /1 of 2 referenced repo settings exist/.test(r.out),
    `and the secret it COULD judge still counts as judged (got ${r.out.trim()})`,
  );
}

// The control that stops this from being the guard switched off: an org listing
// that was READ and does not hold the name is still a real finding.
{
  const r = runChecker(stub([], [], { kind: "empty" }), { "a.yml": PLAIN_WORKFLOW });
  assert(r.code !== 0, "a setting neither scope defines still fails");
  assert(
    r.out.includes("vars.SLATE_BASE_URL") && r.out.includes("secrets.BOOKING_API_KEY"),
    `and both are named (got ${r.out.trim()})`,
  );
  assert(
    !/could NOT be checked/.test(r.out),
    "and nothing is reported unchecked, because the org listing was read",
  );
}

// A repository owned by a PERSON has no organisation at all, so the org endpoint
// answers 404. That is not a refusal: there is no second scope to read, the repo
// listing already saw everything, and treating it as unreadable would turn every
// real finding into an unchecked one while printing reassuring output.
{
  const r = runChecker(stub([], [], { kind: "no-such-org" }), { "a.yml": PLAIN_WORKFLOW });
  assert(r.code !== 0, "a repo with no organisation behind it still reports a missing setting");
  assert(
    r.out.includes("vars.SLATE_BASE_URL"),
    `and names it (got ${r.out.trim()})`,
  );
  assert(
    !/could NOT be checked/.test(r.out),
    "and reports nothing as unchecked, since there was nothing more to read",
  );
}

// gh answering with no owner is a read that failed, not an absent organisation, so
// it must not be folded into the 404 case above.
{
  const r = runChecker(stub([], [], { kind: "no-owner" }), { "a.yml": PLAIN_WORKFLOW });
  assert(r.code === 0, "an unresolvable owner does not block the push");
  assert(
    /could NOT be checked/.test(r.out) && /owner/i.test(r.out),
    `and says the owner is what could not be resolved (got ${r.out.trim()})`,
  );
}

// A fully configured repo never asks the organisation at all, so it pays no extra
// round trips. Proved by a stub that FAILS every org call: reaching one would make
// this case loud rather than leaving the saving to be assumed.
{
  const r = runChecker(
    stub(REAL_VARS, REAL_SECRETS, { kind: "refused", message: "the org listing was reached" }),
  );
  assert(r.code === 0, `a fully configured repo passes (got ${r.out.trim()})`);
  assert(
    !r.out.includes("the org listing was reached"),
    `and never asked the organisation (got ${r.out.trim()})`,
  );
}

finish();
