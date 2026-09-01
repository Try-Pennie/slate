// #1043: the pre-push reminder that a change touching authorization, webhooks,
// routing or the schema wants a `/security-review`.
//
// Review in this repo is self-merge with the automated gates as the only reviewer,
// which is a documented trade (docs/review-process.md). Its one soft spot is
// judgement about who may do what: a test suite proves the code does what it says and
// cannot notice that what it says is too permissive.
//
// Deliberately a REMINDER and not a gate. Nothing in CI can run a review that needs a
// person, so a blocking version would be a gate whose only satisfying action is to set
// its own skip variable, which teaches people to set skip variables. That makes the
// exit code part of the contract, not an accident, so it is asserted.
//
// Run: node --experimental-strip-types scripts/test-security-review-reminder.ts
import { spawnSync } from "node:child_process";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPT = ".githooks/lib/security-review-reminder.sh";

function run(paths: string, env: Record<string, string> = {}) {
  const res = spawnSync("bash", [SCRIPT, paths], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { out: `${res.stdout}${res.stderr}`, code: res.status ?? -1 };
}

// --- it never blocks ---------------------------------------------------------
{
  // The whole contract. If this ever exits non-zero it becomes a gate nobody can
  // satisfy except by skipping it.
  for (const paths of [
    "src/lib/auth/roles.ts",
    "README.md",
    "UNKNOWN",
    "",
    "supabase/migrations/0112_thing.sql",
  ]) {
    eq(run(paths).code, 0, `never blocks the push (${paths || "empty"})`);
  }
}

// --- it speaks on the sensitive surfaces -------------------------------------
const SENSITIVE = [
  "src/lib/auth/roles.ts",
  "src/lib/auth.ts",
  "src/lib/provision.ts",
  "src/lib/bearer-auth.ts",
  "src/lib/api/same-origin.ts",
  "src/middleware.ts",
  "src/app/api/admin/bookings/[id]/cancel/route.ts",
  "src/lib/webhooks/emit.ts",
  "src/lib/routing/tiers.ts",
  "src/lib/rate-limit-core.ts",
  "supabase/migrations/0112_thing.sql",
];
for (const path of SENSITIVE) {
  const { out } = run(path);
  assert(out.includes("/security-review"), `reminds on ${path}`);
  assert(out.includes(path), `and names the file: ${path}`);
}

// --- and stays quiet otherwise ----------------------------------------------
// The negative half matters as much: a reminder that fires on every push is noise,
// and noise is how a real one stops being read (L36).
for (const path of [
  "README.md",
  "src/components/Booker.tsx",
  "src/lib/booking/booker-copy.ts",
  "docs/api.md",
  "scripts/test-migrations.ts",
]) {
  const { out } = run(path);
  eq(out.trim(), "", `silent on ${path}`);
}

// --- an unreadable diff says so rather than going quiet ----------------------
{
  // The hook passes the literal UNKNOWN when it cannot read the diff. Staying quiet
  // there is how a check becomes silent exactly when it cannot see (#1436).
  const { out } = run("UNKNOWN");
  assert(out.includes("/security-review"), "an unreadable diff still reminds");
  assert(
    out.toLowerCase().includes("could not read"),
    "and says it could not tell, rather than implying it measured something",
  );
}

// --- one file among many is still caught ------------------------------------
{
  const { out } = run("README.md\nsrc/lib/auth/roles.ts\ndocs/api.md");
  assert(out.includes("src/lib/auth/roles.ts"), "one sensitive file in a mixed push is caught");
  assert(!out.includes("README.md"), "and only the sensitive ones are listed");
}

// --- a long list is truncated rather than flooding the terminal --------------
{
  const many = Array.from({ length: 14 }, (_, i) => `src/lib/routing/f${i}.ts`).join("\n");
  const { out } = run(many);
  assert(out.includes("and 4 more"), "a long list is truncated with the remaining count");
}

// --- the override is honoured ------------------------------------------------
{
  const { out, code } = run("src/lib/auth/roles.ts", { SKIP_SECURITY_REVIEW_REMINDER: "1" });
  eq(out.trim(), "", "the override silences it");
  eq(code, 0, "and still exits 0");
}

finish();
