// A Slack post with NO dependencies (#1524).
//
// The main-push guard is the only control over pushes to main: native branch protection
// needs a paid org plan, so the whole design rests on this workflow failing the run AND
// telling a human. Its classification logic is pure, but it reached Slack through the
// app's notifier, and that carries a chain the guard has no use for:
//
//   postSlack -> defaultAlertsChannel -> supabaseAdmin -> @supabase/supabase-js
//
// which is why the workflow needed pnpm/action-setup, setup-node and a full
// `pnpm install --frozen-lockfile` on the critical path. On 2026-08-17 run 32039856279
// died downloading pnpm/action-setup with a 429 after three retries and the guard never
// ran. Every dependency it carries is another way for it to be unavailable in exactly
// the conditions it exists for.
//
// So this module imports NOTHING (node's global fetch), which lets the workflow drop the
// install entirely. What it deliberately does NOT duplicate is the wording: the alert text
// still comes from `buildViolationMessage`, shared by both routes, so there is no second
// copy of any copy anywhere (L41). Only the HTTP call is local.
//
// It is a scripts/ module rather than a src/ one on purpose: src/ is the app, which runs
// on the Cloudflare runtime and legitimately wants the tunable channel from the database.
// This is the one caller that must survive without it.

// #3528: the same escape the app's send point applies, from the one local copy. These
// messages carry commit subjects and canary text people wrote, and write no links, so
// no link origin is allowed.
import { slackSafeMrkdwn } from "./slack-mrkdwn.ts";

/** The bit of `fetch` this needs, so a test can hand it a fake with no network. */
export type SlackFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface SlackPostResult {
  ok: boolean;
  /** Slack's own error, or ours. Present whenever ok is false. */
  error?: string;
}

/** Same cap as the app's poster: a slow Slack must not hold a job open indefinitely. */
const TIMEOUT_MS = 8000;

/**
 * A poster bound to a token, matching the `PostFn` shape `check-main-push.ts` already
 * takes, so the runner's own logic is unchanged and stays testable with a fake.
 *
 * Every failure is NAMED and never silent. The caller uses `ok` to decide whether a human
 * was actually told about an unreviewed push to main, so a quiet success here would leave
 * the run red with nobody told and nothing anywhere saying so.
 */
export function makeSlackPoster(opts: {
  token: string;
  channel?: string;
  fetchImpl?: SlackFetch;
}): (msg: { text: string; channel?: string }) => Promise<SlackPostResult> {
  const doFetch: SlackFetch =
    opts.fetchImpl ??
    ((url, init) => fetch(url, init).then((r) => ({ status: r.status, json: () => r.json() })));

  return async (msg) => {
    const token = opts.token.trim();
    // Distinct reasons, because they need different fixes: one is a secret to set, the
    // other a variable, and "could not post" covering both sends the reader nowhere (L11).
    if (!token) return { ok: false, error: "slack-not-configured" };
    const channel = (msg.channel ?? opts.channel ?? "").trim();
    // With the database lookup gone there is no default to fall back to. Refusing loudly
    // is the only honest option: posting into an empty channel id would report as sent.
    if (!channel) return { ok: false, error: "slack-channel-not-configured" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ channel, text: slackSafeMrkdwn(msg.text, []) }),
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `slack http ${res.status}` };
      }
      // Success is Slack's OWN ok field, never the status code and never a substring of
      // the response. chat.postMessage answers 200 with `{ok:false, error:...}` for a bad
      // channel, a revoked token and a rate limit, so reading the status would score
      // every one of those as delivered (L156).
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        return { ok: false, error: `slack body unreadable: ${errText(err)}` };
      }
      const parsed = body as { ok?: unknown; error?: unknown } | null;
      if (parsed?.ok === true) return { ok: true };
      const reason = typeof parsed?.error === "string" ? parsed.error : "slack-rejected";
      return { ok: false, error: reason };
    } catch (err) {
      return { ok: false, error: errText(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Post `text` to the alerts channel the workflow names, and say whether it landed
 * (#3171). Every bare node alerter ends with this, so it is the one place the
 * channel is read: `scripts/test-alerts-channel-poster.ts` fails on a script that
 * reads SLACK_ALERTS_CHANNEL itself.
 *
 * The channel comes from the workflow, never from a database lookup (#1598). An
 * empty value is passed as no channel, so the poster refuses it by name
 * (slack-channel-not-configured) rather than posting into nowhere, because an unset
 * repo variable interpolates to the empty string (#1500).
 */
export async function postToAlertsChannel(
  post: (msg: { text: string; channel?: string }) => Promise<{ ok: boolean; error?: string }>,
  text: string,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; reason: string }> {
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text, ...(channel ? { channel } : {}) });
  return res.ok ? { ok: true, reason: "posted" } : { ok: false, reason: res.error ?? "unknown-error" };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
