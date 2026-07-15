// A CI guard that cannot run must FAIL LOUDLY, never `exit 0`. A job that passes
// green while checking nothing is worse than no job at all: it manufactures
// confidence. Both halves of AUD-018 live here.
//
// #233 (deploy): the deploy job only runs on a push to main, so a missing
// CLOUDFLARE_API_TOKEN there is never a legitimate skip. It means main is silently
// NOT deploying while CI shows green.
//
// #766 (migration-drift): the same swallow, and it was live. Every run passed in
// ~9 seconds logging "SUPABASE_ACCESS_TOKEN not set; skipping migration drift
// check", so the guard that is supposed to stop code merging ahead of its schema
// had been verifying nothing since it was written.
// Run: node --experimental-strip-types scripts/test-ci-fail-loud.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

/** Shell only. A comment that mentions `exit 0` (this file's own rationale does) is prose,
 *  not a swallow, and matching it would fail the build for explaining itself. */
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

// The deploy job stays gated to main pushes (so a missing token can only mean a
// real, must-not-be-silent failure).
assert(
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(ci),
  "deploy job runs only on a push to main",
);

// The missing-token branch of the deploy step.
const branch = ci.match(/if \[ -z "\$CLOUDFLARE_API_TOKEN" \]; then([\s\S]*?)\n\s*fi/);
assert(branch != null, "deploy step still guards on a missing CLOUDFLARE_API_TOKEN");
const body = codeOnly(branch?.[1] ?? "");

assert(
  !/\bexit 0\b/.test(body),
  "deploy does NOT silently `exit 0` when the token is missing (#233)",
);
assert(
  /\bexit 1\b/.test(body),
  "deploy FAILS (`exit 1`) when the token is missing on main (#233)",
);
assert(
  /::error/.test(body),
  "deploy emits a GitHub ::error annotation so a non-deploying main is impossible to miss (#233)",
);

// #766: the migration-drift job. Same contract, same reason.
//
// Anchor these to the whole job block, NOT to the missing-secret `if` branch. Matching
// the branch and then asserting "no exit 0 inside it" passes vacuously the moment the
// regex stops matching, which is the same pass-while-checking-nothing bug this file
// exists to prevent. Assert on the job, so a rewrite that drops the guard entirely is
// still caught.
const migJob = ci.match(/\n {2}migration-drift:\n([\s\S]*?)(?=\n {2}\w[\w-]*:\n|$)/);
assert(migJob != null, "migration-drift job still exists in ci.yml (#766)");
const migBody = codeOnly(migJob?.[1] ?? "");
assert(migBody.length > 0, "migration-drift job body was actually parsed (#766)");

assert(
  !/\bexit 0\b/.test(migBody),
  "migration-drift NEVER `exit 0`s past a check it could not run: it passed green in ~9s doing nothing for months (#766)",
);
assert(
  /\bexit 1\b/.test(migBody),
  "migration-drift FAILS (`exit 1`) when its secrets are missing (#766)",
);
assert(
  /::error/.test(migBody),
  "migration-drift emits a GitHub ::error annotation so an unconfigured migration guard is impossible to miss (#766)",
);
assert(
  /-z "\$SUPABASE_ACCESS_TOKEN"/.test(migBody) && /-z "\$SUPABASE_DB_PASSWORD"/.test(migBody),
  "migration-drift checks BOTH secrets it needs: linked with no DB password, it cannot list migrations either (#766)",
);

// #482: main must NOT deploy code ahead of unapplied schema. Deploys don't apply
// migrations (that stays a human step, see docs/migrations-runbook.md), so the
// deploy job DEPENDS ON migration-drift: if a migration is still unapplied when a
// merge reaches main, deploy fails loudly instead of shipping a feature whose
// schema is missing. Anchor to the whole deploy job block so dropping the `needs`
// entirely is caught, not just changing it.
const deployJob = ci.match(/\n {2}deploy:\n([\s\S]*?)(?=\n {2}\w[\w-]*:\n|$)/);
assert(deployJob != null, "deploy job still exists in ci.yml (#482)");
const deployNeeds = deployJob?.[1].match(/(?:^|\n)\s*needs:\s*(.+)/)?.[1] ?? "";
assert(
  /\bmigration-drift\b/.test(deployNeeds),
  "deploy depends on migration-drift so main cannot ship code ahead of unapplied schema (#482)",
);
assert(/\bci\b/.test(deployNeeds), "deploy still depends on ci (#482)");

finish();
