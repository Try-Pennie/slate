// Repo invariant (#1494): a workflow-run script's env vars are actually wired.
//
// The http->https redirect guard that stops a lead submitting their name, email
// and phone in the clear (#1024) sat armed-in-name-only for two weeks. Its flag,
// EXPECT_HTTPS_REDIRECT, was set as a repo Actions variable on 2026-07-31 and
// `gh variable list` showed it the whole time; the workflow simply never named it
// in the step's `env:`, so `process.env.EXPECT_HTTPS_REDIRECT` was undefined on
// every run and the check reported "WARN: not armed" instead of being able to
// page. A guard that LOOKS configured and is inert is worse than a missing one.
//
// So this asserts the two halves agree: every env var a script run by a workflow
// reads is named in the `env:` of at least one step that runs it, or carries a
// stated `// env-ok:` opt-out saying why its absent value is the one CI wants.
//
// It carries a positive control, because a scan that matches nothing reads
// exactly like a clean pass (L98/L100): the fixture below is the real defect's
// shape, and the guard must flag it.
//
// Run: node --experimental-strip-types scripts/test-workflow-env-coverage.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, fail, finish } from "./lib/harness.ts";
import {
  declaredExemptions,
  findUncoveredEnv,
  parseWorkflowSteps,
  readEnvNames,
} from "./lib/scan-workflow-env-coverage.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// --- positive control: the exact #1494 shape must be caught ---
{
  const wf = `
jobs:
  canary:
    steps:
      - uses: actions/checkout@v6
      - name: Booking smoke (dry-run health tick)
        env:
          BOOKING_API_KEY: \${{ secrets.BOOKING_API_KEY }}
          SMOKE_DRY_RUN_ONLY: "1"
        run: node scripts/smoke-fixture.ts
`;
  const steps = parseWorkflowSteps(wf);
  eq(steps.length, 1, "control: finds the one step that runs a script");
  eq(steps[0]!.scripts.join(","), "scripts/smoke-fixture.ts", "control: reads the script path off the run: line");
  eq(
    steps[0]!.env.sort().join(","),
    "BOOKING_API_KEY,SMOKE_DRY_RUN_ONLY",
    "control: reads the step's env keys",
  );

  const source = `
    const KEY = process.env.BOOKING_API_KEY ?? "";
    const armed = process.env.EXPECT_HTTPS_REDIRECT === "1";
    const only = process.env.SMOKE_DRY_RUN_ONLY;
  `;
  const found = findUncoveredEnv(steps, () => source);
  eq(
    found.map((f) => f.variable).join(","),
    "EXPECT_HTTPS_REDIRECT",
    "control: flags the read the workflow never wires, and only that one",
  );
  eq(
    found[0]!.steps.join(","),
    "Booking smoke (dry-run health tick)",
    "control: names the step where the wiring belongs",
  );

  // And the opt-out really exempts, so the escape hatch is usable.
  const exempted = findUncoveredEnv(
    steps,
    () => `${source}\n// env-ok: EXPECT_HTTPS_REDIRECT (local only)`,
  );
  eq(exempted.length, 0, "control: an env-ok declaration exempts the read");
}

// --- the union rule: several steps in different modes, one script ---
{
  const wf = `
jobs:
  j:
    steps:
      - name: dry
        env:
          SMOKE_DRY_RUN_ONLY: "1"
        run: node scripts/s.ts
      - name: full
        env:
          SMOKE_STRICT: "1"
        run: node scripts/s.ts
`;
  const steps = parseWorkflowSteps(wf);
  eq(steps.length, 2, "union: both steps parsed");
  const found = findUncoveredEnv(
    steps,
    () => `process.env.SMOKE_DRY_RUN_ONLY; process.env.SMOKE_STRICT;`,
  );
  eq(found.length, 0, "union: a var wired by ANY step that runs the script counts as covered");
}

// --- parsing shapes GitHub allows ---
{
  const wf = `
jobs:
  j:
    steps:
      - name: block run
        env:
          A_VAR: "1"
        run: |
          base="x"
          node --experimental-strip-types scripts/multi.ts
      - name: no script here
        run: pnpm install --frozen-lockfile
`;
  const steps = parseWorkflowSteps(wf);
  eq(steps.length, 1, "parse: a step whose run: block invokes no script is not a subject");
  eq(steps[0]!.scripts.join(","), "scripts/multi.ts", "parse: finds a script inside a `run: |` block");
  eq(steps[0]!.env.join(","), "A_VAR", "parse: env survives a following block scalar");
}
{
  // A `with:` list inside a step must not be mistaken for the next step, and a
  // step's env must not leak onto it.
  const wf = `
jobs:
  j:
    steps:
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - name: run it
        env:
          ONLY_MINE: "1"
        run: node scripts/x.ts
`;
  const steps = parseWorkflowSteps(wf);
  eq(steps.length, 1, "parse: only the script-running step is returned");
  eq(steps[0]!.env.join(","), "ONLY_MINE", "parse: env is attributed to the right step");
}

// --- the real tree: every workflow, every script it runs ---
{
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert(files.length > 0, `found ${files.length} workflow files to check`);

  let subjects = 0;
  const findings: string[] = [];
  for (const file of files) {
    const steps = parseWorkflowSteps(readFileSync(join(WORKFLOW_DIR, file), "utf8"));
    subjects += steps.length;
    const found = findUncoveredEnv(steps, (script) => {
      try {
        return readFileSync(join(ROOT, script), "utf8");
      } catch {
        // A workflow naming a script that does not exist is its own defect, and
        // an empty string here would silently read as "reads no env vars".
        fail(`${file}: runs ${script}, which does not exist in the repo`);
        return "";
      }
    });
    for (const f of found) {
      findings.push(
        `${file}: ${f.script} reads ${f.variable}, which no step running it provides ` +
          `(steps: ${f.steps.join(" | ")}). Add it to that step's env:, or declare ` +
          `\`// env-ok: ${f.variable} (why)\` in the script.`,
      );
    }
  }

  // The scan matching nothing would look identical to everything passing, so the
  // count of subjects is asserted rather than assumed.
  assert(subjects > 0, `found ${subjects} workflow steps that run a repo script`);
  eq(findings.length, 0, `every env var a workflow-run script reads is wired or declared\n  ${findings.join("\n  ")}`);
}

// --- the arming flag this guard exists for, named explicitly ---
{
  const wf = readFileSync(join(WORKFLOW_DIR, "smoke-canary.yml"), "utf8");
  const steps = parseWorkflowSteps(wf).filter((s) =>
    s.scripts.includes("scripts/smoke-booking-api.ts"),
  );
  assert(steps.length >= 2, `the canary runs the booking smoke in ${steps.length} steps (dry + full)`);
  for (const step of steps) {
    assert(
      step.env.includes("EXPECT_HTTPS_REDIRECT"),
      `"${step.name}" passes EXPECT_HTTPS_REDIRECT, so the redirect guard can page (#1494)`,
    );
  }
  assert(
    /EXPECT_HTTPS_REDIRECT:\s*\$\{\{\s*vars\.EXPECT_HTTPS_REDIRECT\s*\}\}/.test(wf),
    "the flag comes from the repo Actions variable, not a hard-coded literal",
  );
}

// --- the opt-outs that exist must be justified, not bare ---
{
  const source = readFileSync(join(ROOT, "scripts", "smoke-booking-api.ts"), "utf8");
  const names = declaredExemptions(source);
  assert(names.length > 0, `the booking smoke declares ${names.length} env-ok exemptions`);
  for (const name of names) {
    assert(
      readEnvNames(source).includes(name),
      `env-ok names ${name}, which the script really reads (no stale exemption)`,
    );
    const line = source.split("\n").find((l) => new RegExp(`env-ok:\\s*${name}\\b`).test(l)) ?? "";
    assert(
      line.replace(/.*env-ok:\s*[A-Z_0-9]+/, "").trim().length > 10,
      `the ${name} exemption states a reason`,
    );
  }
}

finish();
