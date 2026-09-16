// Every repo setting the workflows reference actually EXISTS (#1500).
// Run: pnpm check:workflow-settings
//
// A workflow can wire `${{ vars.X }}` or `${{ secrets.X }}` for a setting that
// was never created. GitHub does not fail: it interpolates the EMPTY STRING, so
// the step runs with an empty value while the workflow file reads as fully
// configured. On 2026-08-14 that took the production canary down, eleven minutes
// after the merge that introduced it: `SLATE_BASE_URL` was wired to a variable
// that does not exist and the smoke run died on
// `Failed to parse URL from /api/availability?bucket=SMOKE`.
//
// #1498 closed the CONSUMING half (a wired name may no longer be read with a
// non-empty `??` fallback). This is the other half, and each is invisible in the
// file the other lives in.
//
// Deliberately NOT named `test-*.ts`: that glob is the offline unit suite, and
// this one asks GitHub. Its decision logic is pinned offline by
// `scripts/test-workflow-env-coverage.ts`, so the rule is tested even where the
// listing is not available.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mayDeclarePerRun,
  missingRepoSettings,
  perRunDeclarations,
  referencedRepoSettings,
  splitPerRunMissing,
  stalePerRunDeclarations,
  workflowTriggers,
  type RepoSettingRef,
} from "./lib/scan-workflow-env-coverage.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
// A test seam, so the per-run declaration grammar can be driven against fixture
// workflows rather than by committing a broken one to prove the guard catches it.
// It is not a narrowing: a directory holding no workflow fails below, exactly as
// an empty real tree would, so a run pointed somewhere useless refuses rather than
// reporting a clean pass (L320).
const workflowDir = process.env.WORKFLOW_SETTINGS_DIR || join(repoRoot, ".github/workflows");

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/**
 * Names only, never values. `gh` prints values for variables, so the name is
 * projected out with `--json name` and nothing else is read.
 *
 * A listing that FAILS is its own outcome, never an empty set: an empty list and
 * an unauthenticated `gh` are indistinguishable downstream, and the empty one
 * would report every reference as missing while looking like a real finding
 * (L98, L11).
 */
function listNames(kind: "variable" | "secret"): Set<string> {
  try {
    const out = execFileSync("gh", [kind, "list", "--json", "name", "--jq", ".[].name"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    const e = err as { stderr?: string; code?: string };
    fail(
      `could not list repo ${kind}s, so NOTHING was checked. ` +
        `This needs a token with read access to Actions ${kind}s (the default ` +
        `GITHUB_TOKEN does not have it). ${
          e.code === "ENOENT" ? "gh is not installed." : (e.stderr ?? "").trim()
        }`,
    );
  }
}

const referenced: RepoSettingRef[] = [];
const seenIn = new Map<string, string[]>();
/** Per file: the setting names it declares provisioned per run, and why. */
const declaredByFile = new Map<string, Map<string, string>>();
/** Per file: every setting name it references, to catch a declaration nothing uses. */
const referencedByFile = new Map<string, Set<string>>();
const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
if (files.length === 0) fail("no workflow files found, so nothing was checked");

for (const file of files) {
  const yaml = readFileSync(join(workflowDir, file), "utf8");
  const names = new Set<string>();
  for (const ref of referencedRepoSettings(yaml)) {
    const key = `${ref.kind}.${ref.name}`;
    names.add(ref.name);
    if (!seenIn.has(key)) {
      seenIn.set(key, []);
      referenced.push(ref);
    }
    const list = seenIn.get(key)!;
    if (!list.includes(file)) list.push(file);
  }
  referencedByFile.set(file, names);

  const declarations = perRunDeclarations(yaml);
  if (declarations.length > 0) {
    const triggers = workflowTriggers(yaml);
    if (!mayDeclarePerRun(triggers)) {
      fail(
        `${file} declares settings provisioned per run, and it does not run only on ` +
          `workflow_dispatch (it runs on: ${triggers.join(", ") || "nothing this could read"}).\n` +
          `  Those settings are created by hand before a run and deleted after it, so ` +
          `every automatic run would go out on empty strings with nothing to say about it, ` +
          `which is the fault this check exists for.`,
      );
    }
  }
  for (const decl of declarations) {
    if (decl.reason === null) {
      fail(
        `${file} declares settings provisioned per run and gives no reason for it.\n` +
          `  The names are ${decl.names.join(", ") || "(none given)"}.\n` +
          `  Write the reason after the word "because", saying why absence is the normal ` +
          `state, so the declaration keeps covering the next workflow of that kind rather ` +
          `than naming this one.`,
      );
    }
    const forFile = declaredByFile.get(file) ?? new Map<string, string>();
    for (const name of decl.names) forFile.set(name, decl.reason);
    declaredByFile.set(file, forFile);
  }
}
if (referenced.length === 0) {
  fail("no vars or secrets are referenced by any workflow, which cannot be right");
}

const stale = stalePerRunDeclarations(declaredByFile, referencedByFile);
if (stale.length > 0) {
  fail(
    `${stale.length} per-run declaration(s) name a setting the declaring workflow does ` +
      `not reference, so they cover nothing while reading as a considered decision:\n` +
      stale.map((s) => `  ${s.name}  (declared in ${s.file})`).join("\n") +
      `\nDelete the entry, or fix the name.`,
  );
}

const existing = { vars: listNames("variable"), secrets: listNames("secret") };
const missing = missingRepoSettings(referenced, existing);
const { failing, unjudged } = splitPerRunMissing(missing, seenIn, declaredByFile);

// Said out loud, because a run that judged fewer references than it read and a run
// that found everything present must never read the same (L98). The pre-push hook
// echoes any output carrying a `note:` line, so the narrowing is visible at the
// push rather than only to whoever runs this by hand. It is printed BEFORE the
// failure below, so a run that found a real missing setting still says which
// references it never judged, rather than leaving a reader to assume it judged all
// of them.
// Grouped by the declaration that covers them, so one reason is stated once rather
// than repeated beside every name it explains (L579, L605).
if (unjudged.length > 0) {
  const groups = new Map<string, string[]>();
  for (const u of unjudged) {
    const key = `${u.files.join(", ")}\n${u.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), `${u.kind}.${u.name}`]);
  }
  const lines = [...groups].map(([key, names]) => {
    const [where, reason] = key.split("\n");
    return `  ${where}: ${names.join(", ")}\n    because ${reason}`;
  });
  console.log(
    `note: ${unjudged.length} referenced setting(s) are declared provisioned per run and ` +
      `are absent right now, so they were NOT judged:\n${lines.join("\n")}`,
  );
}

if (failing.length > 0) {
  const lines = failing.map((m) => {
    const where = (seenIn.get(`${m.kind}.${m.name}`) ?? []).join(", ");
    const create =
      m.kind === "vars"
        ? `gh variable set ${m.name} --body '<value>'`
        : `gh secret set ${m.name}`;
    return `  ${m.kind}.${m.name}  (referenced in ${where})\n    create it with: ${create}`;
  });
  fail(
    `${failing.length} workflow reference(s) point at a repo setting that does not exist.\n` +
      `GitHub does not fail on these: it substitutes the EMPTY STRING, so the step ` +
      `runs misconfigured and looks configured.\n${lines.join("\n")}`,
  );
}

const judged = referenced.length - unjudged.length;
console.log(
  unjudged.length > 0
    ? `ok: ${judged} of ${referenced.length} referenced repo settings exist; ` +
        `${unjudged.length} declared provisioned per run were not judged ` +
        `(${existing.vars.size} variables, ${existing.secrets.size} secrets listed)`
    : `ok: all ${referenced.length} referenced repo settings exist ` +
        `(${existing.vars.size} variables, ${existing.secrets.size} secrets listed)`,
);
