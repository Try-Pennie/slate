// Is cal.com retired? (#2875) The first step of the two cal.com workflows.
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/calcom-retired-check.ts
//
// Writes `retired=1`, `retired=0` or `retired=unknown` to $GITHUB_OUTPUT (and prints
// it, so a hand run says the same thing). The workflows read it two ways on purpose:
//
// - the hours apply step in schedule-parity.yml runs only on `retired == '0'`, so
//   an unreadable setting writes NOTHING from cal.com over a Slate week;
// - every other cal.com step runs on `retired != '1'`, so an unreadable setting
//   keeps today's behaviour: the comparison still runs and still reports.
//
// Always exits 0. Its answer is the output, and failing the job here would skip the
// steps after it on a failed read, which is the opposite of what those steps need.
// An unreadable answer is still loud: it is a workflow warning annotation, and the
// import script refuses to write on its own read as well.
import { appendFileSync } from "node:fs";
import { judgeSupabaseCredentials } from "./lib/supabase-credentials.ts";
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

function emit(value: "1" | "0" | "unknown", why: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `retired=${value}\n`);
  console.log(`retired=${value}: ${why}`);
  if (value === "unknown") console.log(`::warning::${why}`);
}

const creds = judgeSupabaseCredentials(process.env);
if (!creds.ok) {
  emit("unknown", "no Supabase credentials here, so whether cal.com is retired is unknown; the hours apply is skipped");
} else {
  const { loadCalcomRetired } = await import("@/lib/calcom/retirement");
  const retired = await loadCalcomRetired();
  if (retired === true) emit("1", "cal.com is marked retired on /admin/alerts, so every cal.com step is skipped");
  else if (retired === false) emit("0", "cal.com is live (the parallel run)");
  else emit("unknown", "could not read whether cal.com is retired, so the hours apply is skipped and the comparison runs as usual");
}
