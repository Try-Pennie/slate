/**
 * Scan logic for the workflow env coverage guard (#1494), kept beside its test so
 * it is unit-testable with positive controls.
 *
 * #1494: the http->https redirect guard on the public booker shipped behind an
 * arming flag, `EXPECT_HTTPS_REDIRECT`. The repo Actions variable was set on
 * 2026-07-31, and for two weeks every canary run still printed
 * "WARN: not armed", because a repo variable does NOT reach a step's process
 * unless the workflow names it in that step's `env:`. So the guard READ as
 * configured (the variable is right there in `gh variable list`) while being
 * inert, which is worse than an obviously missing guard: nobody rechecks a
 * control they can see is set.
 *
 * The shape is general. A script's behaviour is decided by env vars; the workflow
 * that runs it decides which of those the process can actually see; and the two
 * halves live in different files, so a var read by the script and named by nobody
 * silently takes its absent branch forever (L3: built is not wired; L46: a value
 * with no live writer). Nothing about it is visible in either file alone.
 *
 * So: every env var a workflow-run script READS must be named in the `env:` of at
 * least one workflow step that runs it, or carry a stated opt-out.
 *
 * **Union, not per step, deliberately.** The same script is run by several steps
 * in different modes (the dry tick sets `SMOKE_DRY_RUN_ONLY`, the full pass sets
 * `SMOKE_STRICT` and `REASSIGN_API_KEY`), so requiring every var in every step
 * would demand exactly the wiring those modes exist to avoid, and the opt-outs
 * would outnumber the real findings until nobody read them. Union catches the
 * defect this exists for (a var no step names at all) with no false positives.
 *
 * The opt-out is `// env-ok: NAME (why)`, anywhere in the script, for a var that
 * is genuinely local-only (a fixture override with a default that CI wants). Say
 * why, and say what the absent value does.
 *
 * NOT covered, on purpose: whether the var's VALUE is correct, and whether the
 * repo variable behind `${{ vars.X }}` exists at all. A `${{ vars.X }}` naming an
 * unset variable injects an EMPTY STRING, which `??` does not treat as absent, so
 * scripts read wired vars through `envOr` (scripts/smoke-env.ts) instead.
 */

/**
 * Env the RUNNER provides with no wiring: GitHub's documented default variables.
 * These are matched by prefix rather than listed one by one, because a hand list
 * of them would be a second registry to keep in step with GitHub's docs (L41),
 * and every name in these namespaces is reserved by the platform anyway.
 */
const RUNNER_PROVIDED_PREFIXES = ["GITHUB_", "RUNNER_", "ACTIONS_"];
const RUNNER_PROVIDED_EXACT = new Set(["CI"]);

/** Whether the GitHub runner sets this variable itself, so no `env:` is needed. */
export function isRunnerProvided(name: string): boolean {
  return (
    RUNNER_PROVIDED_EXACT.has(name) ||
    RUNNER_PROVIDED_PREFIXES.some((p) => name.startsWith(p))
  );
}

/** One workflow step that runs one or more repo scripts. */
export interface WorkflowStep {
  /** The step's `name:` when it has one, else a positional label. */
  name: string;
  /** Repo-relative script paths the step's `run:` block invokes. */
  scripts: string[];
  /** Env var names the step's `env:` block provides. */
  env: string[];
}

export interface EnvCoverageFinding {
  script: string;
  variable: string;
  /** Steps that run this script, for the failure message. */
  steps: string[];
}

/**
 * Pull every step out of a workflow that runs at least one `scripts/*.ts`, with
 * the env keys that step provides.
 *
 * Deliberately a line scan rather than a YAML parse: the repo has no YAML
 * dependency, the shapes here are the two GitHub allows (`env:` mapping, `run:`
 * scalar or block), and a scan cannot fail closed into "no steps found" without
 * the caller noticing, because a workflow with no matched step is itself a
 * failure in the guard (a scan that matches nothing reads exactly like a clean
 * pass, L98/L100).
 */
export function parseWorkflowSteps(yaml: string): WorkflowStep[] {
  const lines = yaml.split("\n");
  const steps: WorkflowStep[] = [];

  // A step begins at a `- ` list item under `steps:`. Track its indent so nested
  // mappings (`env:`, `with:`) are attributed to the right step.
  let current: { name: string; indent: number; scripts: string[]; env: string[] } | null = null;
  let inEnv = false;
  let envIndent = 0;
  let inRun = false;
  let runIndent = 0;

  const flush = () => {
    if (current && current.scripts.length > 0) {
      steps.push({ name: current.name, scripts: current.scripts, env: current.env });
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    const item = line.match(/^(\s*)-\s+(.*)$/);
    if (item) {
      const itemIndent = item[1]!.length;
      // A new list item at or left of the current step's indent ends it. A
      // deeper one is inside the step (e.g. a `with:` list) and is ignored.
      if (!current || itemIndent <= current.indent) {
        flush();
        current = { name: `(step at line ${lines.indexOf(raw) + 1})`, indent: itemIndent, scripts: [], env: [] };
        inEnv = false;
        inRun = false;
        // The first key can sit on the `- ` line itself (`- name: X`).
        const rest = item[2]!;
        const named = rest.match(/^name:\s*(.+)$/);
        if (named) current.name = named[1]!.trim();
        collectScripts(rest, current.scripts);
        continue;
      }
    }

    if (!current) continue;

    // Leaving the step entirely (a key at or left of the step's own indent that
    // is not part of it) is handled by the list-item branch above; jobs-level
    // keys after the last step end the file, which flush() below covers.
    if (indent <= current.indent && !item) {
      flush();
      continue;
    }

    if (inEnv) {
      if (indent > envIndent) {
        const kv = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (kv) current.env.push(kv[1]!);
        continue;
      }
      inEnv = false;
    }

    if (inRun) {
      if (indent > runIndent) {
        collectScripts(line, current.scripts);
        continue;
      }
      inRun = false;
    }

    const named = line.trim().match(/^name:\s*(.+)$/);
    if (named) {
      current.name = named[1]!.trim();
      continue;
    }
    if (/^\s*env:\s*$/.test(line)) {
      inEnv = true;
      envIndent = indent;
      continue;
    }
    const run = line.match(/^\s*run:\s*(.*)$/);
    if (run) {
      const inline = run[1]!.trim();
      if (inline && inline !== "|" && inline !== ">" && inline !== "|-" && inline !== ">-") {
        collectScripts(inline, current.scripts);
      } else {
        inRun = true;
        runIndent = indent;
      }
      continue;
    }
  }
  flush();
  return steps;
}

function collectScripts(text: string, into: string[]): void {
  for (const m of text.matchAll(/(scripts\/[A-Za-z0-9._/-]+\.ts)/g)) {
    if (!into.includes(m[1]!)) into.push(m[1]!);
  }
}

/**
 * Env var names a script reads. Matches the direct `process.env.NAME` form and
 * the bracket form, which is how a wired-but-defaulted var is read via `envOr`
 * (the VALUE is passed, so the read itself stays visible to this scan).
 */
export function readEnvNames(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) out.add(m[1]!);
  for (const m of source.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) out.add(m[1]!);
  return [...out];
}

/** Names declared exempt by an `// env-ok: NAME …` line in the script. */
export function declaredExemptions(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/env-ok:\s*([A-Z][A-Z0-9_]*)/g)) out.add(m[1]!);
  return [...out];
}

/**
 * Every var a workflow-run script reads that no step running it provides and
 * that the script does not exempt.
 *
 * `readSource` is injected so the guard can be driven against fixtures as well
 * as the real tree.
 */
export function findUncoveredEnv(
  steps: WorkflowStep[],
  readSource: (script: string) => string,
): EnvCoverageFinding[] {
  // Union the env each script gets across every step that runs it, and remember
  // which steps those were so a failure names where the wiring belongs.
  const provided = new Map<string, Set<string>>();
  const runBy = new Map<string, string[]>();
  for (const step of steps) {
    for (const script of step.scripts) {
      const p = provided.get(script) ?? new Set<string>();
      for (const name of step.env) p.add(name);
      provided.set(script, p);
      runBy.set(script, [...(runBy.get(script) ?? []), step.name]);
    }
  }

  const findings: EnvCoverageFinding[] = [];
  for (const [script, names] of provided) {
    const source = readSource(script);
    const exempt = new Set(declaredExemptions(source));
    for (const variable of readEnvNames(source).sort()) {
      if (names.has(variable) || exempt.has(variable) || isRunnerProvided(variable)) continue;
      findings.push({ script, variable, steps: runBy.get(script) ?? [] });
    }
  }
  return findings;
}
