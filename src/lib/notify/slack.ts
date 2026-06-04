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
        ...(msg.blocks ? { blocks: msg.blocks } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
