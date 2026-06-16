import { slackBotToken, slackAlertsChannel } from "@/lib/env";

/**
 * Minimal reusable Slack notifier (bot token → chat.postMessage). Configurable
 * to post any text/blocks to any channel — the watch-lapse alert is just the
 * first caller. Never throws and no-ops when unconfigured, so callers (e.g. the
 * cron) can fire-and-forget without guarding.
 */
export interface SlackMessage {
  text: string;
  /** Defaults to SLACK_ALERTS_CHANNEL. */
  channel?: string;
  /** Optional Block Kit payload. */
  blocks?: unknown[];
}

export function slackConfigured(): boolean {
  return slackBotToken().length > 0;
}

async function slackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const token = slackBotToken();
  if (!token) return { ok: false, error: "slack-not-configured" };
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Slack user id for a workspace email (needs the users:read.email scope). */
export async function lookupSlackUserIdByEmail(
  email: string,
): Promise<string | null> {
  const token = slackBotToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as {
      ok: boolean;
      user?: { id?: string };
    };
    return data.ok ? (data.user?.id ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * DM a workspace user by email (needs im:write). Same never-throws contract;
 * false means undeliverable — callers decide whether to fall back to a channel.
 */
export async function dmSlackUserByEmail(
  email: string,
  text: string,
): Promise<boolean> {
  const userId = await lookupSlackUserIdByEmail(email);
  if (!userId) return false;
  const opened = await slackApi("conversations.open", { users: userId });
  const channel = (opened.data?.channel as { id?: string } | undefined)?.id;
  if (!opened.ok || !channel) return false;
  const posted = await slackApi("chat.postMessage", {
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  return posted.ok;
}

export async function postSlack(
  msg: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const token = slackBotToken();
  if (!token) return { ok: false, error: "slack-not-configured" };
  const channel = msg.channel ?? slackAlertsChannel();
  if (!channel) return { ok: false, error: "no-channel" };

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel,
        text: msg.text,
        unfurl_links: false,
        unfurl_media: false,
        ...(msg.blocks ? { blocks: msg.blocks } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
