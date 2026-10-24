// Runs first in `pnpm cf:preview` and stops it in a checkout holding `.env*` or
// `.dev.vars*` files (#3694). The rule and the wording live in
// `scripts/lib/live-env-files.ts`, shared with the browser checks runner.
//
// It reads the directory the command runs in, because that is the one the build
// and wrangler load settings from (pnpm runs a script from the package root).
//
// Run: node --experimental-strip-types scripts/cf-preview-guard.ts
import { readdirSync } from "node:fs";
import { cfPreviewRefusal } from "./lib/live-env-files.ts";

const refusal = cfPreviewRefusal(readdirSync(process.cwd()));
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
