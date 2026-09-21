// One refusal for a verify script with no Supabase credentials (#2572).
//
// Three `verify-*.ts` scripts read `.env.local` / `.dev.vars`, checked for
// `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_URL`, and printed the same
// "FAILED (not-configured)" sentence before exiting 1. The global duplication guard
// named the second copy (a88baccb). `scripts/lib/supabase-credentials.ts` owns the
// judgement and the sentence now, and this drives it without a repo or an env file.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-supabase-credentials.ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  judgeSupabaseCredentials,
  requireSupabaseCredentials,
  SUPABASE_NOT_CONFIGURED,
} from "./lib/supabase-credentials.ts";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// --- the judgement --------------------------------------------------------------
{
  const ok = judgeSupabaseCredentials({
    SUPABASE_SECRET_KEY: " sb_secret_x ",
    NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co ",
  });
  assert(ok.ok, "both set is ok");
  if (ok.ok) {
    eq(ok.url, "https://ref.supabase.co", "the url is trimmed");
    eq(ok.key, "sb_secret_x", "the key is trimmed");
  }
}
const refusals: [string, Record<string, string | undefined>][] = [
  ["nothing set", {}],
  ["only the key", { SUPABASE_SECRET_KEY: "sb_secret_x" }],
  ["only the url", { NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co" }],
  ["a blank key", { SUPABASE_SECRET_KEY: "   ", NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co" }],
  ["a blank url", { SUPABASE_SECRET_KEY: "sb_secret_x", NEXT_PUBLIC_SUPABASE_URL: "" }],
];
for (const [label, env] of refusals) {
  const res = judgeSupabaseCredentials(env);
  assert(!res.ok, `${label} is refused`);
  if (!res.ok) eq(res.message, SUPABASE_NOT_CONFIGURED, `${label} carries the shared sentence`);
}
assert(
  /^FAILED \(not-configured\): /.test(SUPABASE_NOT_CONFIGURED),
  "the sentence opens with the not-configured verdict",
);
assert(
  SUPABASE_NOT_CONFIGURED.includes("SUPABASE_SECRET_KEY") &&
    SUPABASE_NOT_CONFIGURED.includes("NEXT_PUBLIC_SUPABASE_URL"),
  "and names both variables somebody has to set",
);
assert(
  /nothing was read/.test(SUPABASE_NOT_CONFIGURED),
  "and says nothing was read, so a refusal is never mistaken for a finding",
);

// --- the wrapper prints the sentence and exits 1, or returns the pair ------------
{
  const errors: string[] = [];
  let exited: number | null = null;
  let loaded = 0;
  const res = requireSupabaseCredentials({
    env: {},
    loadEnv: () => {
      loaded++;
    },
    error: (l) => errors.push(l),
    exit: (c) => {
      exited = c;
    },
  });
  eq(loaded, 1, "the env files are loaded before judging, so a value in .env.local counts");
  eq(exited, 1, "an absent credential exits 1");
  eq(errors.join("\n"), SUPABASE_NOT_CONFIGURED, "and prints the shared sentence, once");
  eq(res, null, "and hands back nothing to read with");
}
{
  const errors: string[] = [];
  let exited: number | null = null;
  const res = requireSupabaseCredentials({
    env: { SUPABASE_SECRET_KEY: "sb_secret_x", NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co" },
    loadEnv: () => {},
    error: (l) => errors.push(l),
    exit: (c) => {
      exited = c;
    },
  });
  eq(exited, null, "present credentials exit nothing");
  eq(errors.length, 0, "and print nothing");
  eq(res?.url, "https://ref.supabase.co", "and the url is returned");
  eq(res?.key, "sb_secret_x", "with the key");
}

// --- the verify scripts hold no copy of the sentence ---------------------------
const verifyScripts = readdirSync(SCRIPTS_DIR).filter((n) => /^verify-.*\.ts$/.test(n));
assert(verifyScripts.length >= 5, `the verify script list is real (found ${verifyScripts.length})`);
const FRAGMENT = "are needed here; nothing was read";
const holders = verifyScripts.filter((n) =>
  readFileSync(join(SCRIPTS_DIR, n), "utf8").includes(FRAGMENT),
);
assert(
  holders.length === 0,
  `the not-configured sentence lives in scripts/lib/supabase-credentials.ts only; copies in:\n  ${holders.join("\n  ")}`,
);
const users = verifyScripts.filter((n) =>
  readFileSync(join(SCRIPTS_DIR, n), "utf8").includes("requireSupabaseCredentials("),
);
assert(
  users.length >= 3,
  `at least the three scripts that held the copy now call requireSupabaseCredentials (found ${users.length})`,
);

finish();
