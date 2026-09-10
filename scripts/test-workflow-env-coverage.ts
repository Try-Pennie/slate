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
  contradictoryExemptions,
  findUncoveredEnv,
  parseWorkflowSteps,
  readEnvNames,
  unsafeEmptyFallbackReads,
  varsWiredEnvNames,
  missingRepoSettings,
  referencedRepoSettings,
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

// --- a WIRED var must never be read with a non-empty `??` fallback ---
//
// GitHub interpolates an UNSET `${{ vars.X }}` as the empty string, not as
// nothing, so `process.env.X ?? "default"` takes "" and the default never applies.
// #1494 wired SLATE_BASE_URL, converted two scripts to envOr, and missed the shared
// helper every request goes through; the production canary failed 11 minutes after
// the merge with `Failed to parse URL from /api/availability?bucket=SMOKE`.
//
// Enforced rather than patched per site, because patching per site is what caused
// it (L30).
{
  // Positive control first: the guard has to be shown catching the exact shape.
  eq(
    unsafeEmptyFallbackReads(
      'const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app");',
      "SLATE_BASE_URL",
    ).length,
    1,
    "control: a non-empty ?? fallback on a wired var is caught",
  );
  eq(
    unsafeEmptyFallbackReads('const KEY = process.env.BOOKING_API_KEY ?? "";', "BOOKING_API_KEY").length,
    0,
    'control: a `?? ""` fallback is allowed (absent and empty mean the same thing there)',
  );
  eq(
    unsafeEmptyFallbackReads(
      'const B = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app");',
      "SLATE_BASE_URL",
    ).length,
    0,
    "control: the envOr form is not flagged",
  );
  eq(
    unsafeEmptyFallbackReads(
      '// const B = process.env.SLATE_BASE_URL ?? "https://x";',
      "SLATE_BASE_URL",
    ).length,
    0,
    "control: a commented-out read is not flagged",
  );

  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  const wired = new Set<string>();
  for (const file of files) {
    for (const name of varsWiredEnvNames(readFileSync(join(WORKFLOW_DIR, file), "utf8"))) {
      wired.add(name);
    }
  }
  assert(wired.size > 0, `${wired.size} env vars are wired from vars./secrets. expressions`);

  // Every script in scripts/, not only the ones a workflow runs directly: the
  // failure came from a SHARED helper that no workflow names, reached through a
  // script that one does.
  const scriptFiles = readdirSync(join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("scripts", f))
    .concat(
      readdirSync(join(ROOT, "scripts", "lib"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("scripts", "lib", f)),
    );
  // This file is excluded from its own scan: the positive controls above hold the
  // bad shape as string literals ON PURPOSE, and a guard that flagged its own proof
  // would have to drop the proof to go green. Named explicitly rather than by a
  // pattern, so the exclusion cannot quietly widen to cover a real script.
  const SELF = join("scripts", "test-workflow-env-coverage.ts");
  const offenders: string[] = [];
  for (const rel of scriptFiles) {
    if (rel === SELF) continue;
    const source = readFileSync(join(ROOT, rel), "utf8");
    for (const name of wired) {
      for (const hit of unsafeEmptyFallbackReads(source, name)) {
        offenders.push(
          `${rel}: \`${hit}\` reads a WIRED var with a non-empty ?? fallback. An unset ` +
            `\${{ vars.${name} }} arrives as "", which ?? accepts, so the fallback never ` +
            `applies. Use envOr(process.env.${name}, <default>) from scripts/smoke-env.ts.`,
        );
      }
    }
  }
  eq(offenders.length, 0, `no script reads a wired env var with a non-empty ?? fallback\n  ${offenders.join("\n  ")}`);
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

// --- #1500: the setting a workflow REFERENCES has to exist -----------------------
//
// The sibling of the wiring check above, and each is blind where the other looks:
// that one reads the LEFT side of `FOO: ${{ vars.BAR }}` (the env name a script
// reads), this one reads the RIGHT side (the setting that has to exist). A
// reference to a setting nobody created is not an error to GitHub: it substitutes
// the EMPTY STRING, so the step runs misconfigured and the file reads as
// configured. That is what took the production canary down on 2026-08-14.
//
// The live comparison needs GitHub (`pnpm check:workflow-settings`), so what is
// pinned here is the DECISION: what counts as a reference, what is built in, and
// what counts as missing. Without this the rule would exist only where it cannot
// be tested.
{
  const yaml = [
    "env:",
    "  SLATE_BASE_URL: ${{ vars.SLATE_BASE_URL }}",
    "  BOOKING_API_KEY: ${{ secrets.BOOKING_API_KEY }}",
    "  TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "if: ${{ vars.EXPECT_HTTPS_REDIRECT }}",
    "run: echo ${{ vars.SLATE_BASE_URL }}",
  ].join("\n");
  const refs = referencedRepoSettings(yaml);
  const keys = refs.map((r) => `${r.kind}.${r.name}`).sort();

  assert(
    JSON.stringify(keys) ===
      JSON.stringify([
        "secrets.BOOKING_API_KEY",
        "vars.EXPECT_HTTPS_REDIRECT",
        "vars.SLATE_BASE_URL",
      ]),
    `every reference is found once, wherever it appears (got ${keys.join(", ")})`,
  );
  // An `if:` and a `run:` reference are just as empty and just as silent as an
  // env one, so the scan is deliberately not restricted to the env shape.
  assert(
    keys.includes("vars.EXPECT_HTTPS_REDIRECT"),
    "a reference outside an env block still counts",
  );
  assert(
    !keys.includes("secrets.GITHUB_TOKEN"),
    "GITHUB_TOKEN is minted per run and must never be reported missing",
  );

  const existing = {
    vars: new Set(["EXPECT_HTTPS_REDIRECT"]),
    secrets: new Set(["BOOKING_API_KEY"]),
  };
  const missing = missingRepoSettings(refs, existing);
  assert(
    missing.length === 1 && missing[0].kind === "vars" && missing[0].name === "SLATE_BASE_URL",
    `only the setting that does not exist is reported (got ${JSON.stringify(missing)})`,
  );
  // Both directions: a kind mismatch is still missing, because a VARIABLE named
  // like a secret does not satisfy a `secrets.` reference.
  assert(
    missingRepoSettings(
      [{ kind: "secrets", name: "EXPECT_HTTPS_REDIRECT" }],
      existing,
    ).length === 1,
    "a variable does not satisfy a secrets reference of the same name",
  );
  assert(
    missingRepoSettings(refs, {
      vars: new Set(["EXPECT_HTTPS_REDIRECT", "SLATE_BASE_URL"]),
      secrets: new Set(["BOOKING_API_KEY"]),
    }).length === 0,
    "and nothing is reported once every referenced setting exists",
  );
}

// The scan runs over the REAL workflows too, so a rewrite that stopped matching
// anything cannot pass as "no references found". An empty result here is the
// failure mode the live checker refuses on, and it would be invisible above,
// where the fixture is hand written (L98).
{
  const dir = join(ROOT, ".github", "workflows");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    for (const r of referencedRepoSettings(readFileSync(join(dir, file), "utf8"))) {
      found.add(`${r.kind}.${r.name}`);
    }
  }
  assert(
    found.size >= 5,
    `the real workflows reference settings the scan can see (found ${found.size})`,
  );
  assert(
    found.has("secrets.BOOKING_API_KEY"),
    "including a secret the canary genuinely depends on",
  );
}

// --- an exemption that says the value is REQUIRED is not an exemption -----------
//
// `env-ok` means one thing: this variable is genuinely local only, and CI wanting
// it absent is the correct state. A declaration whose reason opens with "required"
// asserts the exact opposite, and the scanner could not tell, because it matched
// the NAME and never read the reason beside it.
//
// That is not hypothetical. #2153 made the cal.com parity sweep read Twilio's
// worker tags, declared the three credentials `// env-ok: TWILIO_... (required; ...)`,
// and never wired them into the workflow. The guard written to catch exactly that
// had been told to look away from them. The daily lane died on 2026-09-10, the
// first morning after the merge, and the only signal was a heartbeat that would
// have gone stale thirty hours later.
{
  const declared = "// env-ok: SOME_KEY (required; the API key the sweep cannot run without)";
  const bad = contradictoryExemptions(declared);
  eq(bad.length, 1, "an exemption whose reason says required is reported");
  if (bad[0]) eq(bad[0].variable, "SOME_KEY", "and it names the variable");

  // The controls, both directions. Without these the check could be satisfied by a
  // rule that fires on everything, or on nothing.
  eq(
    contradictoryExemptions("// env-ok: SOME_KEY (optional; defaults to 250)").length,
    0,
    "an optional one is left alone, which is what the opt-out is for",
  );
  eq(
    contradictoryExemptions("// env-ok: SOME_KEY (local only)").length,
    0,
    "and so is a local-only one",
  );
  eq(
    contradictoryExemptions("// env-ok: SOME_KEY (not required in CI; the default is what we want)").length,
    0,
    "a reason that says NOT required is not the contradiction being hunted",
  );
}
{
  // The real tree, which is the only place this can rot. A declaration added later
  // with a required reason must fail here rather than be found by a dead lane.
  const offenders = readdirSync(join(ROOT, "scripts"))
    // This file is excluded and it has to be: it cannot test the pattern without
    // writing the pattern, so a scanner run over the whole tree matches its own
    // fixtures and reports itself (L245). The exclusion is by exact name, so it
    // covers this file and nothing else.
    .filter((f) => f.endsWith(".ts") && f !== "test-workflow-env-coverage.ts")
    .flatMap((f) =>
      contradictoryExemptions(readFileSync(join(ROOT, "scripts", f), "utf8")).map((c) => ({
        file: f,
        variable: c.variable,
      })),
    );
  eq(
    offenders.length,
    0,
    `no script declares a REQUIRED variable exempt from wiring (${offenders.map((o) => `${o.file}:${o.variable}`).join(", ")})`,
  );
}

finish();
