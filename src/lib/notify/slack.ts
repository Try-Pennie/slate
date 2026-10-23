import { appUrl, slackBotToken } from "@/lib/env";
import { log } from "@/lib/log";
import { isLoadtest, loadtestRefusal } from "@/lib/loadtest-guard";
import { defaultAlertsChannel } from "@/lib/notify/channels";
import { fetchWithinBudget } from "@/lib/call-budget";
import type { SlackChannelListing, SlackChannelOption } from "@/lib/notify/slack-channel-input";
// One copy of the rule for the app and the bare node posters (#3528); no imports of its own.
import { slackSafeBlocks, slackSafeMrkdwn } from "../../../scripts/lib/slack-mrkdwn";

// Slack normally answers in well under a second; cap every call so a slow or
// unreachable Slack can never wedge the flow awaiting it (a booking/OOO submit,
// an approval). On timeout the deadline error is caught like any other failure
// and the call returns not-ok/null, honouring the never-throws contract.
//
// The cap is also held to any enclosing call budget (#3163). A booking that had
// spent its confirm budget paged under the 2 second cleanup allowance, and a Slack
// answering just inside these 8 seconds used to wait on them alone, so the lead was
// held 12 + 8 seconds against the booker's 20 second abort. Inside a budget a post
// now waits only for what the budget has left; outside one it keeps its 8 seconds.
// (That page has gone after the response since #3416, outside every budget, but any
// post still made inside one is held to it.)
const SLACK_TIMEOUT_MS = 8000;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  // Every Slack call in this file goes through here, both `slackApi` and
  // `postSlack`'s own direct post, so this is the whole of Slack's refusal (#2335).
  // A load run alerts about a synthetic roster (the sync lane alerts on calendar
  // failures, and the fault pass makes ninety stubbed agents fail on purpose), and
  // on 2026-09-14 those reached the real channel for six minutes because the only
  // thing holding them back was an empty token. It THROWS and both callers catch it
  // into their existing not-posted answer, so the never-throws contract is kept
  // while the reason is the load test's own rather than "not configured" (L11).
  if (isLoadtest()) {
    log.warn("loadtest-guard", { msg: "slack call refused", url });
    throw new Error(loadtestRefusal("Slack"));
  }
  // The global fetch is read at call time, never captured, so a test's stub applies.
  return fetchWithinBudget((input, req) => fetch(input, req), url, init, SLACK_TIMEOUT_MS, "slack");
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

/**
 * The `error` these calls answer with when this deployment holds no bot token.
 *
 * Named because a caller has to be able to tell it apart from a refusal Slack
 * itself gave (`not_in_channel`, `ratelimited`): those are worth retrying and this
 * one can never be, since nothing about a later attempt from the same deployment
 * will be different (L11). Exported so the one caller that branches on it compares
 * against this rather than against its own copy of the spelling.
 */
export const SLACK_NOT_CONFIGURED = "slack-not-configured";

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

/**
 * What a person typed is escaped HERE, where every message leaves Slate (#3528, L757),
 * never at each sender. An agent's time off reason went into the manager's notice as
 * typed, so a reason of `<!channel>` pinged the whole fallback channel; the one sender
 * that guarded against it did so for itself alone. `slackSafeMrkdwn` escapes Slack's
 * three characters and keeps only links to the app itself, which is every link Slate
 * writes. Applied to a message's `text`, its `blocks` and a modal's `view`.
 * `scripts/test-slack-send-points.ts` fails on any other file that posts to Slack.
 */
function safeMessage(body: Record<string, unknown>): Record<string, unknown> {
  const origins = [appUrl()];
  const out = { ...body };
  if (typeof out.text === "string") out.text = slackSafeMrkdwn(out.text, origins);
  if (out.blocks !== undefined) out.blocks = slackSafeBlocks(out.blocks, origins);
  if (out.view !== undefined) out.view = slackSafeBlocks(out.view, origins);
  return out;
}

async function slackApi(
  method: string,
  body: Record<string, unknown>,
  encoding: SlackEncoding = "json",
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const token = slackBotToken();
  if (!token) return { ok: false, error: SLACK_NOT_CONFIGURED };
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
          : JSON.stringify(safeMessage(body)),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The channels this workspace has, for the picker (#1957) and for turning a
 * typed channel NAME into its id at save time (#2438).
 *
 * The issue's title is the whole point: a person picks a channel by NAME and
 * Slate stores the id. Before this the field took an id typed from memory and
 * accepted anything.
 *
 * Paginated, and deliberately BOUNDED rather than exhaustive. The picker suggests
 * without restricting: the field still takes any id pasted into it, so a channel
 * past the bound (or a private one, which needs `groups:read`) is reachable by
 * its id and is then checked by `fetchSlackChannel` like any other. Measured
 * 2026-09-06 the workspace has 13 public channels, one page.
 *
 * Never throws. An unreadable list SAYS so (`readable: false`) rather than
 * answering an empty one (#2438): the save reads this to resolve a typed name,
 * and an empty list standing for "could not read" would refuse a real channel
 * as one that does not exist. A list cut short by a failed later page or by the
 * bound says so too (`complete: false`), and keeps what it read.
 */
export async function listSlackChannels(): Promise<SlackChannelListing> {
  const out: SlackChannelOption[] = [];
  let cursor = "";
  let complete = false;
  for (let page = 0; page < 5; page++) {
    const reply = await slackApi(
      "conversations.list",
      { limit: 200, exclude_archived: true, types: "public_channel", ...(cursor ? { cursor } : {}) },
      "form",
    );
    if (!reply.ok) {
      if (page === 0) return { readable: false, why: reply.error ?? "Slack did not answer" };
      break;
    }
    for (const c of (reply.data?.channels ?? []) as { id?: string; name?: string; is_member?: boolean }[]) {
      if (typeof c.id === "string" && typeof c.name === "string") {
        out.push({ id: c.id, name: c.name, isMember: c.is_member === true });
      }
    }
    const meta = reply.data?.response_metadata as { next_cursor?: string } | undefined;
    cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
    if (!cursor) {
      complete = true;
      break;
    }
  }
  // A channel the bot is IN comes first: those are the ones an alert can
  // actually reach, and the rest need an invite before they will work.
  const channels = out.sort(
    (a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name),
  );
  return { readable: true, channels, complete };
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
  if (!token) return { ok: false, error: SLACK_NOT_CONFIGURED };
  const channel = msg.channel ?? (await defaultAlertsChannel());
  if (!channel) return { ok: false, error: "no-channel" };

  try {
    const res = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        safeMessage({
          channel,
          text: msg.text,
          unfurl_links: false,
          unfurl_media: false,
          ...(msg.blocks ? { blocks: msg.blocks } : {}),
        }),
      ),
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

/**
 * An ephemeral reply to a Slack interaction, posted to its `response_url`
 * (best-effort, never throws). Here rather than in the interactions route so that
 * every message Slate sends passes through `safeMessage` (#3528).
 */
export async function replyToSlackResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetchWithTimeout(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(safeMessage({ response_type: "ephemeral", text })),
    });
  } catch {
    /* best-effort: the click already happened, and a lost note changes nothing it did */
  }
}
