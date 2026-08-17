// Runner for the main-push backstop (#1027), invoked by
// .github/workflows/main-push-guard.yml on every push to main. Reads the GitHub
// context the workflow gathered, classifies it (scripts/lib/main-push-guard.ts),
// and on a violation posts a Slack alert AND exits non-zero so the run goes red.
//
// Fails loud: a violation always exits 1, even if the Slack post itself fails, so
// the Action never goes green while a bypassed push sits unreviewed. Reuses the
// app's Slack notifier rather than a second implementation, exactly like
// scripts/notify-deploy-failure.ts.
import { fileURLToPath } from "node:url";
import { realpathSync, appendFileSync } from "node:fs";
// #1524: a poster with no dependencies. The app's own notifier reaches Slack through the
// tunable-channel lookup, which reaches Supabase, so importing it made this guard need a
// full `pnpm install` purely to send one message. On 2026-08-17 a 429 downloading
// pnpm/action-setup meant it never ran at all. The WORDING is still shared
// (buildViolationMessage below), so nothing about the copy is duplicated (L41).
import { makeSlackPoster } from "./lib/slack-post.ts";
import {
  classifyPush,
  buildViolationMessage,
  type AssociatedPr,
  type MergeCommitClaim,
  type PushContext,
} from "./lib/main-push-guard.ts";

/**
 * Tell the workflow this guard reached a verdict AND said so, so the `if: failure()`
 * route added in #1523 knows whether it needs to speak (#1523).
 *
 * The marker deliberately does NOT mean "the script started". A violation whose Slack
 * post failed has told nobody, and that is precisely when the curl route has to fire, so
 * it is written only when the push was legitimate or the alert was delivered.
 *
 * Best effort: a guard must never fail because it could not write its own bookkeeping,
 * and GITHUB_OUTPUT is absent on every local run.
 */
function recordHandled(env: Record<string, string | undefined>): void {
  const out = env.GITHUB_OUTPUT?.trim();
  if (!out) return;
  try {
    appendFileSync(out, "handled=true\n");
  } catch {
    // If this cannot be written the failure route posts a second alert about a commit
    // that was already reported. Noisy, and strictly better than silent.
  }
}

/** Injectable poster so the core is testable with a hand-written fake. */
export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

function parsePrs(raw: string | undefined): AssociatedPr[] {
  if (!raw || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("PRS_JSON is not a JSON array");
  }
  return parsed.map((p) => {
    const o = p as Record<string, unknown>;
    return {
      number: Number(o.number ?? 0),
      merged: Boolean(o.merged),
      ciConclusion:
        typeof o.ciConclusion === "string" ? o.ciConclusion : null,
    };
  });
}

/**
 * The claims the workflow gathered, if any (#1447).
 *
 * Shape: `[{ "number": 1446, "isMergeCommitOfThisPush": true, "ciConclusion": "success" }]`.
 * Absent or blank means the fallback route was not needed (the association had an
 * answer) or produced nothing, and both are the empty list: this route can only ever
 * EXCUSE a push, so treating an unreadable value as no claim is the fail-safe side.
 */
function parseClaims(raw: string | undefined): MergeCommitClaim[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((c) => {
      const o = c as Record<string, unknown>;
      return {
        number: Number(o.number ?? 0),
        isMergeCommitOfThisPush: o.isMergeCommitOfThisPush === true,
        ciConclusion: typeof o.ciConclusion === "string" ? o.ciConclusion : null,
      };
    })
    // A claim whose number did not parse is dropped rather than carried as NaN.
    // It could not excuse a push on its own (that turns on the boolean), but it
    // WOULD reach a human as "legitimate merge of PR #NaN", which claims something
    // the guard never measured and points the reader at nothing (L11, L50).
    .filter((c) => Number.isInteger(c.number) && c.number > 0);
}

export function readContextFromEnv(
  env: Record<string, string | undefined>,
): PushContext {
  return {
    headSha: env.HEAD_SHA ?? "",
    commitMessage: env.COMMIT_MESSAGE ?? "",
    actor: env.ACTOR ?? "",
    runUrl: env.RUN_URL ?? "",
    prs: parsePrs(env.PRS_JSON),
    // #1436: the workflow sets PRS_READ_ERROR when `gh api` could not answer, so an
    // unreadable list is not scored as an empty one. Missing (the normal case) means
    // the read succeeded. Anything present, even a whitespace-only value, is treated
    // as a failure: a variable that exists at all here means the read path went wrong,
    // and defaulting the ambiguous case to "readable" would put it back on the branch
    // that accuses somebody of bypassing review.
    prsReadable: (env.PRS_READ_ERROR ?? "") === "",
    claimedBy: parseClaims(env.MERGE_CLAIMS_JSON),
  };
}

export async function run(
  post: PostFn,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; alerted: boolean; unverified?: boolean; reason: string }> {
  const ctx = readContextFromEnv(env);
  const verdict = classifyPush(ctx);
  if (verdict.ok) {
    recordHandled(env);
    return { ok: true, alerted: false, reason: verdict.reason };
  }

  const text = buildViolationMessage(ctx, verdict);
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  // Only a DELIVERED alert counts as handled. Everything else leaves the marker unset so
  // the failure route speaks for this commit.
  if (res.ok) recordHandled(env);
  return {
    ok: false,
    alerted: res.ok,
    unverified: !!verdict.unverified,
    reason: res.ok ? verdict.reason : `${verdict.reason} (slack: ${res.error})`,
  };
}

const isMain =
  !!process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run(
    makeSlackPoster({ token: process.env.SLACK_BOT_TOKEN ?? "" }),
    process.env,
  ).then((res) => {
    if (res.ok) {
      console.log(`main-push-guard: ${res.reason}`);
      process.exit(0);
    }
    if (!res.alerted) {
      console.error(
        `::error title=Slack alert not sent::main-push-guard could not post the violation alert (${res.reason}). Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL.`,
      );
    }
    // The two failures never read the same: one is a commit to review, the other is
    // a check to re-run, and telling someone to revert over a GitHub blip is advice
    // that cannot fix the state they are in.
    if (res.unverified) {
      console.error(
        `::error title=main-push-guard could not check this push::${res.reason}. Re-run this job; main is unguarded for this commit, not proven bad.`,
      );
    } else {
      console.error(
        `::error title=Illegitimate push to main::${res.reason}. See the job log; revert if unintended.`,
      );
    }
    process.exit(1);
  });
}
