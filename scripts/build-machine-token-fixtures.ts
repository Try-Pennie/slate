// #3543: write `src/lib/mcp-booking/machine-token-fixtures.json` from the cases in
// `scripts/lib/machine-token-fixture-cases.ts`. Deterministic (HMAC, fixed claims),
// so running it twice writes the same bytes and `scripts/test-machine-token.ts`
// fails whenever the committed file and the cases disagree.
//
// Run: pnpm build:machine-token-fixtures
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixtureFile } from "./lib/machine-token-fixture-cases.ts";

export const FIXTURE_PATH = fileURLToPath(new URL("../src/lib/mcp-booking/machine-token-fixtures.json", import.meta.url));

const file = await buildFixtureFile();
writeFileSync(FIXTURE_PATH, `${JSON.stringify(file, null, 2)}\n`); // tree-write-ok: this script exists to regenerate the committed fixture file, and is never run by the suite
console.log(`wrote ${file.cases.length} cases to ${FIXTURE_PATH}`);
