// #525: post a Slack alert when the scheduled booking-smoke canary fails, so a
// broken booking path (or a misconfigured smoke key / test fixture) is noticed
// instead of sitting red in the Actions tab unseen. Invoked by
// .github/workflows/smoke-canary.yml on any failed step, mirroring
// notify-deploy-failure.ts.
//
// #3801: it first hands the failure to the Worker (`POST /api/smoke/failure`), which
// posts it through the same throttle as every other condition: at once when a check
// is newly failing, otherwise once a day. Only when that handoff fails does this post
// directly, as it always did, because the canary's alert has to work when the Worker
// is the thing that is down.
//
// Fails loud: a direct Slack post that errors, or Slack being unconfigured, exits
// non-zero so the alert job goes visibly red rather than pretending it warned
// anyone.
//
// #1598: it posts through the dependency free poster (scripts/lib/slack-post.ts) and
// runs on bare node. The canary's own steps still need the install (they drive the
// real booking path through the app), so this does not remove one from the workflow;
// what it removes is the alert's dependence on that install having WORKED. This step
// speaks only when something already went wrong, and a half installed job that cannot
// even say so leaves the failure to be found by somebody reading the Actions tab.
import { runAlerter } from "./lib/run-alerter.ts";
import { postToAlertsChannel } from "./lib/slack-post.ts";
import { failureLogPath, nodeSmokeFailureIo, readFailures, type FailureLogIo } from "./lib/smoke-failure-log.ts";
import { buildSmokeFailureMessage, smokeFailureChecks, type SmokeFailureContext } from "./lib/smoke-failure-message.ts";
import { handOffSmokeFailure, type HandoffFetch } from "./lib/smoke-failure-handoff.ts";

export { buildSmokeFailureMessage, type SmokeFailureContext };

/** Injectable poster so the core is testable with a hand-written fake. */
export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export function readContextFromEnv(
  env: Record<string, string | undefined>,
  io: FailureLogIo = nodeSmokeFailureIo,
): SmokeFailureContext {
  return {
    mode: env.SMOKE_MODE ?? "",
    runUrl: env.RUN_URL ?? "",
    failures: readFailures(io, failureLogPath(env)),
  };
}

/**
 * Hand the failure to the Worker, and post it directly only if the Worker did not
 * take it (#3801). `reason` says which happened, so the job log tells the two apart.
 */
export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
  io: FailureLogIo = nodeSmokeFailureIo,
  doFetch?: HandoffFetch,
): Promise<{ ok: boolean; reason: string }> {
  const ctx = readContextFromEnv(env, io);
  const text = buildSmokeFailureMessage(ctx);
  const handoff = await handOffSmokeFailure(
    { mode: ctx.mode, text, checks: smokeFailureChecks(ctx.failures) },
    env,
    doFetch,
  );
  if (handoff.handled) {
    return { ok: true, reason: handoff.outcome === "sent" ? "posted by the Worker" : "held by the Worker: already posted" };
  }
  const direct = await postToAlertsChannel(post, text, env);
  return direct.ok ? { ok: true, reason: `posted directly (the Worker handoff failed: ${handoff.reason})` } : direct;
}

runAlerter(import.meta.url, async (post, env) => {
  const res = await run(post, env);
  if (!res.ok) {
    console.error(
      `::error title=Smoke-failure alert not sent::Could not post the Slack smoke-failure alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
    );
    return 1;
  }
  console.log(`Smoke-failure alert: ${res.reason}.`);
  return 0;
});
