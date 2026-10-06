// Refuse a pull request that changes a Durable Object class without planning its hand
// deploy (#3352). Run by .github/workflows/do-migration-plan.yml on bare node: it imports
// only scripts/lib/do-migration-plan.ts and what that imports, none of it a package.
// The decision is in that module and pinned by scripts/test-do-migration-plan.ts.
//
// Run: BASE_SHA=<base commit> PR_LABELS='["deploy/hand"]' node --experimental-strip-types scripts/check-do-migration-planned.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doMigrationVerdict } from "./lib/do-migration-plan.ts";

const ROOT = join(import.meta.dirname, "..");

// env-ok: BASE_SHA (the pull request's base commit, from the workflow)
const baseSha = process.env.BASE_SHA ?? "";
let base: string | null = null;
if (/^[0-9a-f]{40}$/.test(baseSha)) {
  try {
    base = execFileSync("git", ["show", `${baseSha}:wrangler.jsonc`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    base = null;
  }
}

// env-ok: PR_LABELS (the pull request's label names as a JSON array, from the workflow)
let labels: string[] = [];
try {
  const parsed: unknown = JSON.parse(process.env.PR_LABELS ?? "[]");
  if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === "string");
} catch {
  // Labels that do not read count as none: a class change is then refused, which is
  // the safe side, and no class change passes whatever the labels say.
}

const verdict = doMigrationVerdict({ base, head: readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"), labels });
if (!verdict.ok) {
  console.error(`FAILED: ${verdict.message}.`);
  process.exit(1);
}
console.log(`${verdict.message}.`);
