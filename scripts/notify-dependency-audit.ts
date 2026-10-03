// Say what the daily dependency audit found (#3092, #3093).
//
// Invoked by .github/workflows/dependency-audit.yml after both audits, whatever they
// exited with. A red scheduled run is a detector nobody is looking at, so this is
// the part that reaches a person. The decision and the wording are in
// `lib/dependency-audit-report.ts`; the post is `lib/post-decision.ts`.
//
// Bare node, no dependency install and no alias hook, like its siblings: an alerter
// carrying an install is another way for it to be unavailable exactly when it is
// needed (#1598). scripts/test-dependency-free-scripts.ts walks its imports.
import { runAlerter } from "./lib/run-alerter.ts";
import { decideAuditAlert } from "./lib/dependency-audit-report.ts";
import { postDecision, type PostFn } from "./lib/post-decision.ts";

export function run(post: PostFn, env: Record<string, string | undefined>) {
  return postDecision(
    post,
    env,
    decideAuditAlert({ prod: env.PROD_AUDIT ?? "", full: env.FULL_AUDIT ?? "", runUrl: env.RUN_URL ?? "" }),
  );
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  console.log(`dependency audit: ${res.detail} (${res.reason})`);
  if (res.code !== 0) console.error(`::error title=Dependency audit::${res.detail} (${res.reason})`);
  return res.code;
});
