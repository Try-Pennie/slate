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
  missingRepoSettings,
  referencedRepoSettings,
  type RepoSettingRef,
} from "./lib/scan-workflow-env-coverage.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const workflowDir = join(repoRoot, ".github/workflows");

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
const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
if (files.length === 0) fail("no workflow files found, so nothing was checked");

for (const file of files) {
  const yaml = readFileSync(join(workflowDir, file), "utf8");
  for (const ref of referencedRepoSettings(yaml)) {
    const key = `${ref.kind}.${ref.name}`;
    if (!seenIn.has(key)) {
      seenIn.set(key, []);
      referenced.push(ref);
    }
    const list = seenIn.get(key)!;
    if (!list.includes(file)) list.push(file);
  }
}
if (referenced.length === 0) {
  fail("no vars or secrets are referenced by any workflow, which cannot be right");
}

const existing = { vars: listNames("variable"), secrets: listNames("secret") };
const missing = missingRepoSettings(referenced, existing);

if (missing.length > 0) {
  const lines = missing.map((m) => {
    const where = (seenIn.get(`${m.kind}.${m.name}`) ?? []).join(", ");
    const create =
      m.kind === "vars"
        ? `gh variable set ${m.name} --body '<value>'`
        : `gh secret set ${m.name}`;
    return `  ${m.kind}.${m.name}  (referenced in ${where})\n    create it with: ${create}`;
  });
  fail(
    `${missing.length} workflow reference(s) point at a repo setting that does not exist.\n` +
      `GitHub does not fail on these: it substitutes the EMPTY STRING, so the step ` +
      `runs misconfigured and looks configured.\n${lines.join("\n")}`,
  );
}

console.log(
  `ok: all ${referenced.length} referenced repo settings exist ` +
    `(${existing.vars.size} variables, ${existing.secrets.size} secrets listed)`,
);
