/**
 * Every GitHub Action is pinned to a full commit SHA (#1051).
 *
 * A tag is mutable. `actions/checkout@v6` means "whatever v6 points at right now",
 * and whoever can move that tag can run their code inside our workflows. That is
 * not hypothetical: the tj-actions/changed-files compromise in March 2025 worked
 * exactly this way, by repointing existing tags at a malicious commit, and every
 * repo pinned by tag executed it on the next run.
 *
 * What it would reach here is the reason this is worth a guard rather than a note.
 * These workflows hold `CLOUDFLARE_API_TOKEN` (deploys the Worker),
 * `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` (the production database),
 * and the Slack credentials. A step running attacker code in that job can read all
 * of them.
 *
 * A SHA cannot be moved. Dependabot's `github-actions` ecosystem entry updates
 * pinned SHAs the same way it updates package versions, so pinning costs nothing
 * ongoing: the version comment beside each SHA is what Dependabot reads and
 * rewrites.
 *
 * Run: node --experimental-strip-types scripts/test-action-pinning.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = ".github/workflows";

/** `uses: owner/repo@ref` (and `- uses:`), capturing the ref. Local (`./…`) and
 *  reusable-workflow refs are out of scope: they are this repo's own code. */
const USES = /^\s*-?\s*uses:\s*(?<action>[^\s@]+)@(?<ref>\S+)/;
const SHA = /^[0-9a-f]{40}$/;

interface Use {
  file: string;
  line: number;
  action: string;
  ref: string;
}

function usesIn(text: string, file: string): Use[] {
  const out: Use[] = [];
  text.split("\n").forEach((raw, i) => {
    // Comments stripped first, so a guard can never be satisfied by prose ABOUT a
    // pin, including a comment explaining that one was removed (L103). The version
    // comment that Dependabot reads sits AFTER the SHA, so this keeps the ref.
    const line = raw.replace(/#.*$/, "");
    const m = USES.exec(line);
    if (!m?.groups) return;
    if (m.groups.action.startsWith(".")) return;
    out.push({ file, line: i + 1, action: m.groups.action, ref: m.groups.ref });
  });
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
assert(files.length > 0, `found workflow files to check (${files.length})`);

const uses = files.flatMap((f) => usesIn(readFileSync(`${DIR}/${f}`, "utf8"), f));
// Without this, deleting every workflow, or renaming the `uses:` key, leaves the
// assertion below passing over nothing at all (L98: finding nothing is not a pass).
assert(uses.length > 0, `found action references to check (${uses.length})`);

{
  const unpinned = uses
    .filter((u) => !SHA.test(u.ref))
    .map((u) => `${u.file}:${u.line} ${u.action}@${u.ref}`);
  eq(
    unpinned,
    [],
    "every action is pinned to a full commit SHA, so a moved tag cannot run new code " +
      "in a job holding the Cloudflare and Supabase production credentials",
  );
}

// Each pinned SHA carries its version as a trailing comment. That is not decoration:
// it is what Dependabot rewrites, so a SHA with no comment silently stops being
// updated and rots at whatever commit it was pinned to.
{
  const uncommented: string[] = [];
  for (const f of files) {
    readFileSync(`${DIR}/${f}`, "utf8")
      .split("\n")
      .forEach((raw, i) => {
        const m = USES.exec(raw.replace(/#.*$/, ""));
        if (!m?.groups || m.groups.action.startsWith(".")) return;
        if (!SHA.test(m.groups.ref)) return;
        if (!/#\s*v?\d/.test(raw)) uncommented.push(`${f}:${i + 1} ${m.groups.action}`);
      });
  }
  eq(uncommented, [], "every pinned SHA names its version in a trailing comment, so Dependabot keeps it fresh");
}

// --- positive control ---------------------------------------------------------
//
// Without this, a renamed key or a broken regex leaves everything above green over
// a file it can no longer read, which is indistinguishable from a clean repo (L1).
{
  const sabotaged = usesIn("      - uses: evil/action@v1\n", "control.yml");
  eq(sabotaged.length, 1, "the scanner still recognises an action reference");
  eq(
    sabotaged.filter((u) => !SHA.test(u.ref)).length,
    1,
    "a tag-pinned action IS caught",
  );
  // And the inverse, so the SHA check cannot be satisfied by matching everything.
  const pinned = usesIn(`      - uses: good/action@${"a".repeat(40)} # v1\n`, "control.yml");
  eq(pinned.filter((u) => !SHA.test(u.ref)).length, 0, "a SHA-pinned action is NOT caught");
}

finish();
