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
 * Env names a workflow wires from a `${{ vars.X }}` or `${{ secrets.X }}`
 * expression.
 *
 * These are the dangerous ones. GitHub does NOT leave the variable undefined when
 * it is unset: it interpolates the empty string. So a script reading one with
 * `process.env.X ?? "default"` takes the EMPTY STRING, because `??` only catches
 * null and undefined, and the default it was written to fall back on never
 * applies.
 *
 * This is not hypothetical. #1494 wired SLATE_BASE_URL for the first time, two
 * scripts were converted to `envOr` and the SHARED helper every request actually
 * goes through was not, and on 2026-08-14 the production canary failed with
 * `Failed to parse URL from /api/availability?bucket=SMOKE`: the base URL was "".
 * Patching the sites one at a time is what caused it, so the rule is enforced
 * instead (L30).
 */
export function varsWiredEnvNames(yaml: string): string[] {
  const out = new Set<string>();
  for (const m of yaml.matchAll(
    /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\$\{\{\s*(?:vars|secrets)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/gm,
  )) {
    out.add(m[1]!);
  }
  return [...out];
}

/**
 * Reads of `name` that fall back with `??` to a NON-EMPTY literal, which is the
 * shape that silently accepts an empty wired value.
 *
 * A fallback of `""` is fine and deliberately allowed: `BOOKING_API_KEY ?? ""`
 * means the same thing whether the value is absent or empty, and those call sites
 * check for emptiness themselves. Only a non-empty default is a promise the `??`
 * cannot keep.
 */
export function unsafeEmptyFallbackReads(source: string, name: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const re = new RegExp(
    String.raw`process\.env\.${name}\s*\?\?\s*("(?:[^"]*)"|'(?:[^']*)'|\`(?:[^\`]*)\`)`,
    "g",
  );
  const hits: string[] = [];
  for (const m of stripped.matchAll(re)) {
    const literal = m[1]!.slice(1, -1);
    if (literal.length > 0) hits.push(m[0]!);
  }
  return hits;
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
 * Exemptions that describe a REQUIRED value, which is a contradiction (#2218).
 *
 * `env-ok` means exactly one thing: this variable is genuinely local only, and CI
 * wanting it absent is the correct state. A reason that opens with "required" says
 * the opposite, and the rest of this scanner cannot tell, because it matches the
 * NAME and never reads the words beside it. A marker whose reason is not itself
 * checked is one somebody can satisfy by writing anything at all (L675).
 *
 * That is what #2153 did: it made the cal.com parity sweep depend on three Twilio
 * credentials, declared all three `env-ok: ... (required; ...)`, and wired none of
 * them. The guard written to catch precisely a var no step provides had been told
 * to look away from them, and the daily lane died the first morning after the
 * merge with nothing but a heartbeat that would go stale thirty hours later.
 *
 * Matched on the FIRST word of the reason, because the house convention already
 * writes `(required; ...)` or `(optional; ...)` or `(local only)`, and matching
 * "required" anywhere would fire on a reason that says "not required in CI",
 * which is a correct exemption saying so in words.
 */
export interface ExemptionContradiction {
  variable: string;
  reason: string;
}

export function contradictoryExemptions(source: string): ExemptionContradiction[] {
  const out: ExemptionContradiction[] = [];
  for (const m of source.matchAll(/env-ok:\s*([A-Z][A-Z0-9_]*)\s*\(?\s*([^)\n]*)/g)) {
    const variable = m[1]!;
    const reason = (m[2] ?? "").trim();
    if (/^required\b/i.test(reason)) out.push({ variable, reason });
  }
  return out;
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

/**
 * Every repo setting a workflow REFERENCES, as `{ kind, name }` (#1500).
 *
 * The sibling of `varsWiredEnvNames`, and each is blind where the other looks:
 * that one reads the LEFT side of `FOO: ${{ vars.BAR }}` (the env name a script
 * will read), this one reads the RIGHT side (the setting that has to exist).
 *
 * A reference to a setting that was never created is not an error to GitHub: it
 * interpolates the empty string, so the step runs with an empty value while the
 * workflow file reads as fully configured. #1495 wired
 * `SLATE_BASE_URL: ${{ vars.SLATE_BASE_URL }}` against a variable that does not
 * exist, and the production canary died on
 * `Failed to parse URL from /api/availability?bucket=SMOKE`.
 *
 * Deliberately NOT restricted to the `NAME: ${{ ... }}` env shape: a reference in
 * an `if:`, a `with:` or a run line is just as empty and just as silent.
 */
export interface RepoSettingRef {
  kind: "vars" | "secrets";
  name: string;
}

/**
 * Settings GitHub provides itself, which no repo lists and which must never be
 * reported missing. `GITHUB_TOKEN` is minted per run; `ACTIONS_*` are set by the
 * runner.
 */
const BUILT_IN_SECRETS = new Set(["GITHUB_TOKEN"]);

export function referencedRepoSettings(yaml: string): RepoSettingRef[] {
  const seen = new Set<string>();
  const out: RepoSettingRef[] = [];
  for (const m of yaml.matchAll(/\$\{\{\s*(vars|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const kind = m[1] as "vars" | "secrets";
    const name = m[2]!;
    if (kind === "secrets" && BUILT_IN_SECRETS.has(name)) continue;
    const key = `${kind}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name });
  }
  return out;
}

/**
 * References with no matching setting in the repo.
 *
 * `existing` is passed in rather than read here, so the comparison stays pure and
 * the caller owns talking to GitHub. The caller must ALSO refuse to run when it
 * could not list: an empty `existing` set and a repo with no settings are
 * indistinguishable here, and treating "could not read" as "nothing exists" would
 * report every reference as missing, while the reverse (an empty REFERENCE set)
 * would pass silently (L98).
 */
export function missingRepoSettings(
  referenced: RepoSettingRef[],
  existing: { vars: Set<string>; secrets: Set<string> },
): RepoSettingRef[] {
  return referenced.filter((r) =>
    r.kind === "vars" ? !existing.vars.has(r.name) : !existing.secrets.has(r.name),
  );
}

/* --------------------------------------------------------------------------
 * Settings that are PROVISIONED PER RUN (#2293)
 *
 * The guard above is right about the fault it was built for: a reference to a
 * setting nobody ever created runs the step on an empty string and reads as
 * configured. It is wrong about a workflow whose settings are created for one run
 * and destroyed with it. `loadtest.yml` (#2244) points at a throwaway Supabase
 * branch and a Worker its own teardown job deletes, so between runs its seven
 * settings genuinely do not exist, and the guard refused every push that touched
 * ANY workflow. The documented way through was the override, which is how a guard
 * stops being read (L36), and it waves a REAL missing setting on another workflow
 * through in the same breath.
 *
 * So a workflow may DECLARE, in its own file, which of its settings are of that
 * kind. Three rules, and each is what keeps this from being the guard turned off:
 *
 * - The names are EXACT and listed one by one (L129: an exemption is named, never
 *   achieved by leaving something out of a table). A `LOADTEST_*` wildcard would
 *   have exempted a typo in a reference, which is exactly the fault being guarded.
 * - The declaration carries a REASON, introduced by `because`, and the reason is
 *   what is checked rather than the presence of the marker (L675). The reason is
 *   written as the reason for exempting, so it keeps covering the next workflow
 *   that provisions its settings per run (L362), rather than naming this one.
 * - It covers only references in the DECLARING file. "Provisioned per run" is a
 *   fact about one workflow's dispatcher, and a second workflow reading the same
 *   setting on a schedule is a real finding.
 *
 * An absent per-run setting is REPORTED, never silently passed, because a run that
 * judged less than everything and a run that found nothing wrong must not read the
 * same (L98). One that EXISTS is judged exactly like any other reference, so this
 * is permission for absence and not an exclusion from the check.
 * -------------------------------------------------------------------------- */

const PER_RUN_MARKER = "settings-provisioned-per-run:";

export interface PerRunDeclaration {
  /** Setting names this file declares are created and destroyed per run. */
  names: string[];
  /** The stated reason, or null when the declaration carries none. */
  reason: string | null;
}

/**
 * Parse a workflow's per-run declarations out of its leading comments.
 *
 * The form, over one or more `#` comment lines:
 *
 *   # settings-provisioned-per-run: NAME_ONE, NAME_TWO,
 *   #   NAME_THREE
 *   #   because they are created by the dispatcher for one run and deleted by the
 *   #   teardown job, so between runs their absence is the normal state.
 *
 * `because` separates the names from the prose, so neither half can be mistaken
 * for the other and an empty reason cannot hide behind the keyword.
 */
export function perRunDeclarations(yaml: string): PerRunDeclaration[] {
  const lines = yaml.split("\n");
  const out: PerRunDeclaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i]!.indexOf(PER_RUN_MARKER);
    if (at < 0 || !/^\s*#/.test(lines[i]!)) continue;
    let text = lines[i]!.slice(at + PER_RUN_MARKER.length);
    // Continue while the following lines are still comments and the declaration
    // has not obviously ended (a blank comment line closes it).
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!/^\s*#/.test(next)) break;
      const body = next.replace(/^\s*#\s?/, "");
      if (!body.trim()) break;
      if (body.includes(PER_RUN_MARKER)) break;
      text += ` ${body}`;
      i = j;
    }
    const split = text.split(/\bbecause\b/);
    const nameText = split[0]!;
    // Whitespace is collapsed because the reason is read across several comment
    // lines, each carrying its own indent, and it is printed back as one sentence.
    const reasonText =
      split.length > 1 ? split.slice(1).join("because").replace(/\s+/g, " ").trim() : "";
    const names: string[] = [];
    for (const m of nameText.matchAll(/[A-Z][A-Z0-9_]*/g)) {
      if (!names.includes(m[0])) names.push(m[0]);
    }
    out.push({ names, reason: isStatedReason(reasonText) ? reasonText : null });
  }
  return out;
}

/**
 * Whether a declaration's reason says anything.
 *
 * It must begin with a WORD, so the surrounding syntax cannot satisfy it (L675),
 * and run to at least three words, because a one word reason ("loadtest") names
 * the case rather than the reason for exempting it (L362, L233).
 */
export function isStatedReason(reason: string): boolean {
  if (!/^[A-Za-z]/.test(reason.trim())) return false;
  return reason.trim().split(/\s+/).length >= 3;
}

/**
 * The events a workflow runs on, read from its top level `on:`.
 *
 * All three forms GitHub allows: `on: push`, `on: [push, pull_request]`, and the
 * mapping. A file this cannot read returns an EMPTY list, which the caller must
 * treat as a refusal rather than as "no triggers", because a per-run declaration
 * is only safe on a workflow a person dispatches (L98).
 */
export function workflowTriggers(yaml: string): string[] {
  const lines = yaml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^on:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1]!.trim().replace(/#.*$/, "").trim();
    if (inline.startsWith("[")) {
      for (const name of inline.replace(/[[\]]/g, "").split(",")) {
        if (name.trim()) out.push(name.trim());
      }
      return out;
    }
    if (inline) return [inline];
    // Only keys at the FIRST indent level under `on:` are triggers. Anything deeper
    // belongs to one of them (`workflow_dispatch:` carries `inputs:`, `push:`
    // carries `branches:`), and counting those as triggers would refuse the very
    // workflow this exists to permit.
    let keyIndent: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) break;
      const key = line.match(/^(\s+)([a-z_]+)\s*:/);
      if (!key) continue;
      const indent = key[1]!.length;
      if (keyIndent === null) keyIndent = indent;
      if (indent === keyIndent) out.push(key[2]!);
    }
    return out;
  }
  return out;
}

/**
 * Whether a workflow may declare settings provisioned per run.
 *
 * Only a workflow somebody DISPATCHES can: the settings are created by hand before
 * the run and deleted after it, so a schedule, a push or any other automatic
 * trigger would fire on empty strings with nothing to say about it, which is the
 * #1495 failure this whole check exists for. Writing the rule this way keeps the
 * exemption tied to the REASON for it rather than to the one workflow that has it
 * today (L362).
 *
 * An unreadable `on:` refuses, because a file whose triggers could not be read and
 * one that runs only on dispatch must not read the same.
 */
export function mayDeclarePerRun(triggers: string[]): boolean {
  return triggers.length > 0 && triggers.every((t) => t === "workflow_dispatch");
}

export interface PerRunUnjudged extends RepoSettingRef {
  /** Files that reference it, all of which declared it provisioned per run. */
  files: string[];
  reason: string;
}

export interface PerRunSplit {
  /** Missing, and at least one file referencing it made no such declaration. */
  failing: RepoSettingRef[];
  /** Missing everywhere it is referenced, and declared per run by every one. */
  unjudged: PerRunUnjudged[];
}

/**
 * Split the missing references into the ones that are a real finding and the ones
 * every referencing file declared are provisioned per run.
 *
 * `declaredByFile` maps a workflow file to the names it declared and the reason it
 * gave. A missing reference is only unjudged when EVERY file that references it
 * declares it: one scheduled workflow reading a setting that only a dispatched run
 * creates is the fault this guard exists for, wherever else it is declared.
 */
export function splitPerRunMissing(
  missing: RepoSettingRef[],
  referencedIn: Map<string, string[]>,
  declaredByFile: Map<string, Map<string, string>>,
): PerRunSplit {
  const failing: RepoSettingRef[] = [];
  const unjudged: PerRunUnjudged[] = [];
  for (const ref of missing) {
    const files = referencedIn.get(`${ref.kind}.${ref.name}`) ?? [];
    const reasons = files.map((f) => declaredByFile.get(f)?.get(ref.name));
    if (files.length > 0 && reasons.every((r) => r !== undefined)) {
      unjudged.push({ ...ref, files, reason: reasons[0]! });
    } else {
      failing.push(ref);
    }
  }
  return { failing, unjudged };
}

export interface StaleDeclaration {
  file: string;
  name: string;
}

/**
 * Declared names the declaring file does not reference at all.
 *
 * A stale entry is the shape of an exemption nobody re-read: it goes on reading as
 * a considered decision while covering nothing, and the next reference that name
 * ever gains is exempt by accident (L129, L346).
 */
export function stalePerRunDeclarations(
  declaredByFile: Map<string, Map<string, string>>,
  referencedByFile: Map<string, Set<string>>,
): StaleDeclaration[] {
  const out: StaleDeclaration[] = [];
  for (const [file, declared] of declaredByFile) {
    const referenced = referencedByFile.get(file) ?? new Set<string>();
    for (const name of declared.keys()) {
      if (!referenced.has(name)) out.push({ file, name });
    }
  }
  return out;
}
