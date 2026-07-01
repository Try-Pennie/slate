import { slackBotToken } from "@/lib/env";
import { defaultAlertsChannel } from "@/lib/notify/channels";

// Slack normally answers in well under a second; cap every call so a slow or
// unreachable Slack can never wedge the flow awaiting it (a booking/OOO submit,
// an approval). On timeout the AbortError is caught like any other failure and
// the call returns not-ok/null, honouring the never-throws contract. Uses the
// AbortController pattern (same as src/lib/webhooks/emit.ts) rather than
// AbortSignal.timeout, to stay on the fetch-timeout shape already proven on the
// Cloudflare runtime.
const SLACK_TIMEOUT_MS = 8000;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

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

/** Where a posted message landed — needed to edit it later via chat.update. */
export interface SlackRef {
  channel: string;
  ts: string;
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
    const res = await fetchWithTimeout(`https://slack.com/api/${method}`, {
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
    const res = await fetchWithTimeout(
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
  blocks?: unknown[],
): Promise<SlackRef | null> {
  const userId = await lookupSlackUserIdByEmail(email);
  if (!userId) return null;
  const opened = await slackApi("conversations.open", { users: userId });
  const channel = (opened.data?.channel as { id?: string } | undefined)?.id;
  if (!opened.ok || !channel) return null;
  const posted = await slackApi("chat.postMessage", {
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
    ...(blocks ? { blocks } : {}),
  });
  const ts = posted.data?.ts as string | undefined;
  return posted.ok && ts ? { channel, ts } : null;
}

/**
 * Edit a previously posted message (chat.update); needs its channel + ts.
 * Always clears blocks (blocks: []) so an interactive notification's buttons
 * disappear once the request is decided, leaving only the updated status text.
 */
export async function updateSlackMessage(
  ref: SlackRef,
  text: string,
): Promise<boolean> {
  const res = await slackApi("chat.update", {
    channel: ref.channel,
    ts: ref.ts,
    text,
    blocks: [],
    unfurl_links: false,
    unfurl_media: false,
  });
  return res.ok;
}

/** Open a modal from an interaction's trigger_id (views.open). */
export async function openSlackModal(
  triggerId: string,
  view: unknown,
): Promise<boolean> {
  const res = await slackApi("views.open", { trigger_id: triggerId, view });
  return res.ok;
}

/**
 * The workspace email for a Slack user id (needs users:read + users:read.email),
 * or null. users.info is a read method — its `user` arg must ride in the query
 * string (GET), like users.lookupByEmail above; posting it as a JSON body is
 * silently ignored by Slack and the lookup fails.
 */
export async function getSlackUserEmail(userId: string): Promise<string | null> {
  const token = slackBotToken();
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as {
      ok: boolean;
      user?: { profile?: { email?: string } };
    };
    return data.ok ? (data.user?.profile?.email ?? null) : null;
  } catch {
    return null;
  }
}

export async function postSlack(
  msg: SlackMessage,
): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> {
  const token = slackBotToken();
  if (!token) return { ok: false, error: "slack-not-configured" };
  const channel = msg.channel ?? (await defaultAlertsChannel());
  if (!channel) return { ok: false, error: "no-channel" };

  try {
    const res = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
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
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };
    return { ok: data.ok, error: data.error, channel: data.channel, ts: data.ts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
