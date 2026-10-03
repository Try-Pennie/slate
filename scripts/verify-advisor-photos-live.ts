// `pnpm verify:advisor-photos` (#3027): run the advisor photo refresh against the
// LIVE directory and database with every write taken out, so it applies every
// guard the daily lane applies and reports what that lane would do. Writes nothing.
//
// It is deliberately NOT named `test-*.ts`: that glob is the offline unit suite, and
// this needs live Google plus the Supabase secret key from `.env.local` / `.dev.vars`.
//
// The subject is `DIRECTORY_ADMIN_SUBJECT` from the environment when set, otherwise
// the value wrangler.jsonc deploys, so a run checks the account production uses.
//
// Exit codes are in scripts/lib/advisor-photos-verify.ts; only 0 is a pass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

if (!process.env.DIRECTORY_ADMIN_SUBJECT) {
  const wrangler = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
  const deployed = /"DIRECTORY_ADMIN_SUBJECT":\s*"([^"]*)"/.exec(wrangler)?.[1];
  if (deployed) process.env.DIRECTORY_ADMIN_SUBJECT = deployed;
}

const { runPhotoRefresh } = await import("@/lib/advisor-photos/refresh");
const { liveRefreshDeps } = await import("@/lib/advisor-photos/lane");
const { verifyExitCode, verifyReport } = await import("./lib/advisor-photos-verify.ts");

const outcome = await runPhotoRefresh(liveRefreshDeps(false));
for (const line of verifyReport(outcome)) console.log(line);
const code = verifyExitCode(outcome);
console.log(code === 0 ? "\nPASS: a real run would apply cleanly." : `\nNOT A PASS (exit ${code}).`);
process.exit(code);
