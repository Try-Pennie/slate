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
import {
  failureLogPath,
  nodeSmokeFailureIo,
  readFailures,
  type FailureLog,
  type FailureLogIo,
} from "./lib/smoke-failure-log.ts";


export interface SmokeFailureContext {
  /** Which pass ran: "full" (real bookings) or "dry" (side effect free tick). */
  mode: string;
  runUrl: string;
  /** What the run recorded as failing, so the alert can name its own cause (#1492). */
  failures: FailureLog;
}

/**
 * How many failed checks to name in the message. A canary failure is usually one or
 * two checks; a broken deploy can fail every one of them, and thirty lines on a phone
 * mid incident is the #1133 wall of text again. The rest are pointed at, not pasted.
 */
const NAMED_FAILURE_CAP = 6;

/** One failed check, trimmed so a long detail cannot push the run link off screen. */
function failureLine(line: string): string {
  const clean = line.replace(/^FAIL:\s*/i, "").trim();
  if (clean.length <= 160) return `- ${clean}`;
  // Truncate on a word boundary, never mid word: #1133 shipped "mess" as a line
  // ending and that is what made the page unreadable.
  const cut = clean.slice(0, 160);
  const at = cut.lastIndexOf(" ");
  return `- ${(at > 80 ? cut.slice(0, at) : cut).trimEnd()}...`;
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
  const head = `Slate booking canary failed: the ${pass} did not pass against production.`;

  // The whole point of #1492: say WHICH checks failed, so the reader can tell a
  // fixture collision from a booking outage without a code read and a production
  // query. The three states are genuinely different situations and get different
  // second lines, never one sentence covering every cause.
  if (ctx.failures.kind === "failures") {
    const named = ctx.failures.lines.slice(0, NAMED_FAILURE_CAP).map(failureLine);
    const rest = ctx.failures.lines.length - named.length;
    const more = rest > 0 ? `\n(and ${rest} more in the run)` : "";
    const count =
      ctx.failures.lines.length === 1 ? "1 check failed" : `${ctx.failures.lines.length} checks failed`;
    return [`${head} ${count}:`, named.join("\n") + more, ctx.runUrl].join("\n");
  }
  if (ctx.failures.kind === "unreadable") {
    return [
      `${head} Which checks failed could not be read (${ctx.failures.reason}), so the run itself is the only record.`,
      ctx.runUrl,
    ].join("\n");
  }
  // No check reported at all. That is not "nothing failed": it means the run died
  // before any check ran, which is what an unparseable base URL or a missing key
  // looks like, and it points somewhere different from a failed check.
  return [
    `${head} No check reported a result, so the run stopped before the checks began: look for a crash, a missing key, or a misconfigured base URL rather than a booking regression.`,
    ctx.runUrl,
  ].join("\n");
}

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

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
  io: FailureLogIo = nodeSmokeFailureIo,
): Promise<{ ok: boolean; reason: string }> {
  const text = buildSmokeFailureMessage(readContextFromEnv(env, io));
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
