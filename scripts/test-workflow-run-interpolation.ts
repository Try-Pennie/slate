// No workflow `run:` script interpolates a caller controlled value (#3175).
//
// GitHub substitutes `${{ ... }}` into a `run:` script as TEXT before the shell ever
// sees it, so a value somebody else chose (a workflow_dispatch input, a branch name,
// anything under `github.event`) becomes shell code: `fault_pct` set to `10"; curl ...`
// runs the curl, on a runner holding the Cloudflare deploy token. The loadtest deploy
// step did exactly that with `inputs.fault_pct`, which semgrep's p/owasp-top-ten
// reports as run-shell-injection. The fix is the documented one: hand the value to
// the step through `env:`, where it arrives as data, and read it as a quoted shell
// variable.
//
// This guard is the offline half of that: semgrep runs in CI only, while this runs
// in the pre-push gate. It reads every workflow and the shared actions, extracts
// what each step RUNS (a single line or a `run: |` block), and fails on an
// interpolation of `inputs.*`, `github.event.*` or `github.head_ref`. Values the
// repo controls (`github.sha`, `vars.*`, `secrets.*`, `steps.*.outputs`) are not
// judged here; they are not something a caller can choose.
// Run: node --experimental-strip-types scripts/test-workflow-run-interpolation.ts
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const CALLER_CONTROLLED = /\$\{\{[^}]*\b(?:inputs\.|github\.event\.|github\.head_ref\b)/;

/** Every `run:` script in a workflow or action file, with the 1-based line it starts on. */
export function runScripts(yaml: string): { line: number; script: string }[] {
  const lines = yaml.split("\n");
  const out: { line: number; script: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const first = m[2]!.trim();
    if (!/^[|>][-+]?$/.test(first)) {
      out.push({ line: i + 1, script: first });
      continue;
    }
    const indent = lines[i]!.match(/^\s*/)![0].length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== "" && l.match(/^\s*/)![0].length <= indent) break;
      block.push(l);
    }
    out.push({ line: i + 1, script: block.join("\n") });
  }
  return out;
}

/** The start lines of every run script that interpolates a caller controlled value. */
export function injectableRuns(yaml: string): number[] {
  return runScripts(yaml)
    .filter((r) => r.script.split("\n").some((l) => !/^\s*#/.test(l) && CALLER_CONTROLLED.test(l)))
    .map((r) => r.line);
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p));
    else if (/\.ya?ml$/.test(name)) out.push(p);
  }
  return out;
}

// --- the real tree --------------------------------------------------------------
const files = [...yamlFiles(join(ROOT, ".github", "workflows")), ...yamlFiles(join(ROOT, ".github", "actions"))];
assert(files.length >= 10, `found the workflows and shared actions (${files.length})`);
let scripts = 0;
for (const f of files) {
  const yaml = readFileSync(f, "utf8");
  scripts += runScripts(yaml).length;
  eq(injectableRuns(yaml).join(","), "", `${relative(ROOT, f)} runs no script interpolating a caller controlled value`);
}
assert(scripts >= 50, `and read their run scripts (${scripts})`);

// --- positive controls ----------------------------------------------------------
eq(
  injectableRuns(
    '      - name: Deploy\n        run: npx wrangler deploy --env loadtest --var SLATE_LOADTEST_FAULT_PCT:"${{ inputs.fault_pct }}"\n',
  ),
  [2],
  "the #3175 shape, a workflow_dispatch input in a one line run, is caught",
);
eq(
  injectableRuns('      - run: |\n          set -e\n          echo "${{ github.event.pull_request.title }}"\n      - run: echo ok\n'),
  [1],
  "an event field inside a run block is caught, at the step it belongs to",
);
eq(injectableRuns("      - run: echo \"${{ github.head_ref }}\"\n"), [1], "the head ref is caught");
eq(
  injectableRuns(
    '      - name: Deploy\n        env:\n          FAULT_PCT: ${{ inputs.fault_pct }}\n        run: npx wrangler deploy --var "SLATE_LOADTEST_FAULT_PCT:${FAULT_PCT}"\n',
  ),
  [],
  "the fix, the value handed through env and read as a shell variable, passes",
);
eq(
  injectableRuns('      - run: echo "${{ github.sha }} ${{ vars.X }} ${{ steps.a.outputs.b }}"\n'),
  [],
  "values the repo controls are not judged",
);
eq(
  injectableRuns("      - run: |\n          # was: ${{ inputs.fault_pct }}\n          echo ok\n"),
  [],
  "a comment inside a run block runs nothing",
);

finish();
