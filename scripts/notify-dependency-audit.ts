// Say what the daily dependency audit found (#3092, #3093).
//
// Invoked by .github/workflows/dependency-audit.yml after both audits, whatever they
// exited with. A red scheduled run is a detector nobody is looking at, so this is
// the part that reaches a person. The decision and the wording are in
// `lib/dependency-audit-report.ts`; only the post is here.
//
// Bare node, no dependency install and no alias hook, like its siblings: an alerter
// carrying an install is another way for it to be unavailable exactly when it is
// needed (#1598). scripts/test-dependency-free-scripts.ts walks its imports.
import { runAlerter } from "./lib/run-alerter.ts";
import { decideAuditAlert } from "./lib/dependency-audit-report.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ code: number; reason: string; detail: string }> {
  const decision = decideAuditAlert({
    prod: env.PROD_AUDIT ?? "",
    full: env.FULL_AUDIT ?? "",
    runUrl: env.RUN_URL ?? "",
  });
  if (decision.alert === null) return { code: 0, reason: "nothing to say", detail: decision.detail };
  // The channel comes from the workflow, never from a database lookup (#1598). An
  // empty value is refused by name rather than posted into nowhere.
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text: decision.alert, ...(channel ? { channel } : {}) });
  // A finding and an undelivered message are both red: a posted alert does not make
  // the advisory go away, and an unsent one is not evidence that there is none.
  return { code: 1, reason: res.ok ? "posted" : (res.error ?? "unknown-error"), detail: decision.detail };
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  console.log(`dependency audit: ${res.detail} (${res.reason})`);
  if (res.code !== 0) console.error(`::error title=Dependency audit::${res.detail} (${res.reason})`);
  return res.code;
});
