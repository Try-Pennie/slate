// #233: the deploy job must FAIL LOUDLY (not silently `exit 0`) when
// CLOUDFLARE_API_TOKEN is missing. The deploy job only runs on a push to main
// (its `if:` gates to refs/heads/main), so a missing token there is never a
// legitimate skip: it means main is silently NOT deploying while CI shows green.
// This guards against regressing to the old `exit 0` swallow.
// Run: node --experimental-strip-types scripts/test-deploy-fail-loud.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
};

// The deploy job stays gated to main pushes (so a missing token can only mean a
// real, must-not-be-silent failure).
assert(
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(ci),
  "deploy job runs only on a push to main",
);

// The missing-token branch of the deploy step.
const branch = ci.match(/if \[ -z "\$CLOUDFLARE_API_TOKEN" \]; then([\s\S]*?)\n\s*fi/);
assert(branch != null, "deploy step still guards on a missing CLOUDFLARE_API_TOKEN");
const body = branch?.[1] ?? "";

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
