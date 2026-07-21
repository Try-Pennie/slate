// #525: post a Slack alert when the scheduled booking-smoke canary fails, so a
// broken booking path (or a misconfigured smoke key / test fixture) is noticed
// instead of sitting red in the Actions tab unseen. Invoked by
// .github/workflows/smoke-canary.yml on any failed step. Reuses the app's Slack
// notifier (src/lib/notify/slack.ts) rather than a second Slack implementation,
// mirroring notify-deploy-failure.ts.
//
// Fails loud: a Slack post that errors, or Slack being unconfigured, exits
// non-zero so the alert job goes visibly red rather than pretending it warned
// anyone.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { postSlack } from "@/lib/notify/slack";

export interface SmokeFailureContext {
  /** Which pass ran: "full" (real bookings) or "dry" (side effect free tick). */
  mode: string;
  runUrl: string;
}

/** Injectable poster so the core is testable with a hand-written fake. */
export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export function buildSmokeFailureMessage(ctx: SmokeFailureContext): string {
  const pass =
    ctx.mode === "full"
      ? "full end to end booking smoke"
      : "booking smoke health check";
  return [
    `Slate booking canary failed: the ${pass} did not pass against production.`,
    `Either booking is broken, or a smoke key or seeded test fixture is misconfigured. Check the run, and the seeded SMOKE test agents and buckets.`,
    ctx.runUrl,
  ].join("\n");
}

export function readContextFromEnv(
  env: Record<string, string | undefined>,
): SmokeFailureContext {
  return { mode: env.SMOKE_MODE ?? "", runUrl: env.RUN_URL ?? "" };
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  const text = buildSmokeFailureMessage(readContextFromEnv(env));
  // Pass the channel explicitly so the notifier does not need the app's Supabase
  // config in CI; an empty value lets postSlack report "no-channel" (fail loud).
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  return res.ok
    ? { ok: true, reason: "posted" }
    : { ok: false, reason: res.error ?? "unknown-error" };
}

const isMain =
  !!process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run(postSlack, process.env).then((res) => {
    if (!res.ok) {
      console.error(
        `::error title=Smoke-failure alert not sent::Could not post the Slack smoke-failure alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.`,
      );
      process.exit(1);
    }
    console.log("Posted smoke-failure alert to Slack.");
    process.exit(0);
  });
}
