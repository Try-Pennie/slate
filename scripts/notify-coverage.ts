// Tell a person when the nightly coverage ratchet regressed or measured nothing (#3101).
//
// Invoked by .github/workflows/coverage.yml after the coverage run, whatever it exited
// with. The decision and the wording are in `lib/coverage-alert.ts`; the post is
// `lib/post-decision.ts`; only the file read is here.
//
// Bare node, no dependency install and no alias hook, like its siblings (#1598):
// scripts/test-dependency-free-scripts.ts walks its imports.
import { existsSync, readFileSync } from "node:fs";
import { runAlerter } from "./lib/run-alerter.ts";
import { decideCoverageAlert } from "./lib/coverage-alert.ts";
import { postDecision, type PostFn } from "./lib/post-decision.ts";

/** Where coverage.mjs writes its verdicts, relative to the repo root the job runs in. */
export const VERDICT_PATH = "coverage/verdict.json";

export function run(
  post: PostFn,
  env: Record<string, string | undefined>,
  readVerdict: () => string | null,
) {
  return postDecision(post, env, decideCoverageAlert(readVerdict(), env.RUN_URL ?? ""));
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env, () =>
    existsSync(VERDICT_PATH) ? readFileSync(VERDICT_PATH, "utf8") : null,
  );
  console.log(`coverage alert: ${res.detail} (${res.reason})`);
  if (res.code !== 0) console.error(`::error title=Coverage::${res.detail} (${res.reason})`);
  return res.code;
});
