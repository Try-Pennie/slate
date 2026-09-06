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

/**
 * ENCODING IS PER METHOD, not a house style (#1957).
 *
 * Slack's write methods take a JSON body. Its READ methods do not: measured
 * against the live workspace on 2026-09-06, `conversations.info` answers
 * `invalid_arguments` to a JSON body for every channel, including a real one the
 * bot is a member of, and answers correctly to the same argument form encoded.
 *
 * That failure is the shape worth naming, because it is indistinguishable from
 * the finding the caller is looking for: an error string, about the channel, on
 * a request that reached Slack. Nothing but sending the real request could have
 * told the two apart (L52).
 */
type SlackEncoding = "json" | "form";

async function slackApi(
  method: string,
  body: Record<string, unknown>,
  encoding: SlackEncoding = "json",
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const token = slackBotToken();
  if (!token) return { ok: false, error: "slack-not-configured" };
  try {
    const res = await fetchWithTimeout(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type":
          encoding === "form"
            ? "application/x-www-form-urlencoded; charset=utf-8"
            : "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body:
        encoding === "form"
          ? new URLSearchParams(
              Object.entries(body).map(([k, v]) => [k, String(v)]),
            ).toString()
          : JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The channels this workspace has, for the picker (#1957).
 *
 * The issue's title is the whole point: a person picks a channel by NAME and
 * Slate stores the id. Before this the field took an id typed from memory and
 * accepted anything.
 *
 * Paginated, and deliberately BOUNDED rather than exhaustive. The list feeds a
 * `datalist`, which suggests without restricting: the field still takes any id
 * typed into it, so a channel past the bound (or a private one, which needs
 * `groups:read`) is reachable by typing it and is then checked by
 * `fetchSlackChannel` like any other. Measured 2026-09-06 the workspace has 13
 * public channels, one page.
 *
 * Never throws, and an unreadable list is an EMPTY list of suggestions rather
 * than a broken page: the field it decorates works without it.
 */
export async function listSlackChannels(): Promise<{ id: string; name: string; isMember: boolean }[]> {
  const out: { id: string; name: string; isMember: boolean }[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const reply = await slackApi(
      "conversations.list",
      { limit: 200, exclude_archived: true, types: "public_channel", ...(cursor ? { cursor } : {}) },
      "form",
    );
    if (!reply.ok) break;
    for (const c of (reply.data?.channels ?? []) as { id?: string; name?: string; is_member?: boolean }[]) {
      if (typeof c.id === "string" && typeof c.name === "string") {
        out.push({ id: c.id, name: c.name, isMember: c.is_member === true });
      }
    }
    const meta = reply.data?.response_metadata as { next_cursor?: string } | undefined;
    cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
    if (!cursor) break;
  }
  // A channel the bot is IN comes first: those are the ones an alert can
  // actually reach, and the rest need an invite before they will work.
  return out.sort(
    (a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name),
  );
}

/**
 * Ask Slack about one channel id (#1957).
 *
 * **The Slate app already carries `channels:read`.** #1957 assumed it did not,
 * and that a Slack app configuration change by Dan was a prerequisite. Measured
 * against the live workspace on 2026-09-06 it is not: this call answers with the
 * channel's name and the bot's membership today, and answers `channel_not_found`
 * for an id that does not exist. So the check works as shipped.
 *
 * `groups:read` governs PRIVATE channels and has not been measured, so the
 * `missing_scope` branch stays: it is the honest answer for a destination this
 * cannot see, and it says it could not check rather than passing judgement.
 *
 * Returns Slack's raw reply. The reading of it is pure and lives in
 * `slack-channel-check.ts`, so every branch is driven offline.
 */
export async function fetchSlackChannel(
  channel: string,
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  return slackApi("conversations.info", { channel }, "form");
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
