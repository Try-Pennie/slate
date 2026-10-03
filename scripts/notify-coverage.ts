// Tell a person when the nightly coverage ratchet regressed or measured nothing (#3101).
//
// Invoked by .github/workflows/coverage.yml after the coverage run, whatever it exited
// with. The decision and the wording are in `lib/coverage-alert.ts`; only the file read
// and the post are here.
//
// Bare node, no dependency install and no alias hook, like its siblings (#1598):
// scripts/test-dependency-free-scripts.ts walks its imports.
import { existsSync, readFileSync } from "node:fs";
import { runAlerter } from "./lib/run-alerter.ts";
import { decideCoverageAlert } from "./lib/coverage-alert.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/** Where coverage.mjs writes its verdicts, relative to the repo root the job runs in. */
export const VERDICT_PATH = "coverage/verdict.json";

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
  readVerdict: () => string | null,
): Promise<{ code: number; reason: string; detail: string }> {
  const decision = decideCoverageAlert(readVerdict(), env.RUN_URL ?? "");
  if (decision.alert === null) return { code: 0, reason: "nothing to say", detail: decision.detail };
  // The channel comes from the workflow, never from a database lookup (#1598).
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text: decision.alert, ...(channel ? { channel } : {}) });
  // Red either way: a posted alert does not restore the coverage, and an unsent one is
  // not evidence that it held.
  return { code: 1, reason: res.ok ? "posted" : (res.error ?? "unknown-error"), detail: decision.detail };
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env, () =>
    existsSync(VERDICT_PATH) ? readFileSync(VERDICT_PATH, "utf8") : null,
  );
  console.log(`coverage alert: ${res.detail} (${res.reason})`);
  if (res.code !== 0) console.error(`::error title=Coverage::${res.detail} (${res.reason})`);
  return res.code;
});
