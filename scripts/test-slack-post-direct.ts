// #1524: a Slack post the main-push guard can make with nothing installed.
//
// The guard is the only control over main (native branch protection needs a paid plan),
// so its whole job is to be the thing that still works when something else has gone
// wrong. It was reaching Slack through the app's own notifier, and that pulls in the
// tunable-channel lookup, which pulls in the Supabase client: `postSlack` ->
// `defaultAlertsChannel` -> `supabaseAdmin` -> @supabase/supabase-js. So a workflow whose
// classification logic is pure needed pnpm, setup-node and a full frozen install, and on
// 2026-08-17 a 429 downloading `pnpm/action-setup` meant the guard never ran at all.
//
// This poster has no imports. The WORDING is not duplicated with it: the message still
// comes from `buildViolationMessage`, which both routes share, so there is no second copy
// of any copy (L41). Only the HTTP call is local.
//
// Run: node --experimental-strip-types scripts/test-slack-post-direct.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { makeSlackPoster, type SlackFetch } from "./lib/slack-post.ts";

/** A fake fetch recording what it was asked to send. */
function fakeFetch(
  reply: { status?: number; body?: unknown; throws?: string },
): { impl: SlackFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: SlackFetch = async (url, init) => {
    calls.push({ url, init });
    if (reply.throws) throw new Error(reply.throws);
    return {
      status: reply.status ?? 200,
      json: async () => reply.body ?? { ok: true },
    };
  };
  return { impl, calls };
}

// --- the happy path -------------------------------------------------------
{
  const { impl, calls } = fakeFetch({ body: { ok: true } });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(res.ok, "a Slack ok:true is a successful post");
  eq(calls.length, 1, "exactly one request is made");
  eq(calls[0]!.url, "https://slack.com/api/chat.postMessage", "it posts to chat.postMessage");
  const sent = JSON.parse(String(calls[0]!.init.body)) as { channel: string; text: string };
  eq(sent.channel, "C123", "the channel is sent");
  eq(sent.text, "hello", "the text is sent");
  const headers = calls[0]!.init.headers as Record<string, string>;
  eq(headers.Authorization, "Bearer xoxb-test", "the bot token is sent as a bearer token");
}

// --- #3528: what a person wrote is escaped at this send point too -------------
{
  // These posts carry commit subjects and canary text, written by people. This poster is
  // the second of the two places Slate posts to Slack, so it applies the same rule as the
  // app's (scripts/lib/slack-mrkdwn.ts). It writes no links, so none is kept.
  const { impl, calls } = fakeFetch({ body: { ok: true } });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  await post({ text: "Fix <!channel> & <https://evil.example|this>", channel: "C123" });
  const sent = JSON.parse(String(calls[0]!.init.body)) as { text: string };
  eq(sent.text, "Fix &lt;!channel&gt; &amp; &lt;https://evil.example|this&gt;", "a mention or link someone wrote reaches Slack as text");
}

// --- the failures, which are the point ------------------------------------
{
  // Slack answers HTTP 200 with ok:false for a bad channel, a revoked token, a rate
  // limit. Deciding success from the status code would score every one of those as sent,
  // and this poster's caller uses that answer to decide whether anybody was told.
  const { impl } = fakeFetch({ status: 200, body: { ok: false, error: "channel_not_found" } });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(!res.ok, "an HTTP 200 carrying ok:false is NOT a successful post");
  eq(res.error, "channel_not_found", "and Slack's own reason is carried back");
}

{
  const { impl } = fakeFetch({ status: 500, body: {} });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(!res.ok, "a 500 is not a successful post");
  assert((res.error ?? "").includes("500"), "and the status is named");
}

{
  // A body that is not JSON at all: Slack behind an error page, or a proxy. Must not
  // throw out of the poster, and must not be read as sent.
  const impl: SlackFetch = async () => ({
    status: 200,
    json: async () => {
      throw new Error("Unexpected token < in JSON");
    },
  });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(!res.ok, "an unparseable body is not a successful post");
  assert((res.error ?? "").length > 0, "and it says why");
}

{
  const { impl, calls } = fakeFetch({ throws: "getaddrinfo ENOTFOUND slack.com" });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(!res.ok, "a network failure is not a successful post");
  assert((res.error ?? "").includes("ENOTFOUND"), "and the cause is carried back");
  eq(calls.length, 1, "and it was actually attempted");
}

{
  // No token. This must be a NAMED failure and never a silent no-op: the caller decides
  // from res.ok whether a human was told about an unreviewed push to main, so a quiet
  // success here would mean the run goes red with nobody told and nothing saying so.
  const { impl, calls } = fakeFetch({ body: { ok: true } });
  const post = makeSlackPoster({ token: "", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "C123" });
  assert(!res.ok, "a missing bot token is a failure, not a silent success");
  eq(res.error, "slack-not-configured", "with a reason a reader can act on");
  eq(calls.length, 0, "and no pointless request is made");
}

{
  // No channel. Same rule: with the DB lookup gone there is no default to fall back to,
  // so an empty channel has to be refused loudly rather than posted into nowhere.
  const { impl, calls } = fakeFetch({ body: { ok: true } });
  const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
  const res = await post({ text: "hello", channel: "  " });
  assert(!res.ok, "a blank channel is a failure, not a post into nowhere");
  eq(res.error, "slack-channel-not-configured", "with its OWN reason, distinct from a missing token (L11)");
  eq(calls.length, 0, "and no pointless request is made");
}

{
  // Never throws, whatever happens. The caller is a guard that must still exit 1 on a
  // violation even when telling somebody failed.
  let threw = false;
  const impl: SlackFetch = () => {
    throw new Error("synchronous explosion");
  };
  try {
    const post = makeSlackPoster({ token: "xoxb-test", fetchImpl: impl });
    const res = await post({ text: "hello", channel: "C123" });
    assert(!res.ok, "a synchronous throw is reported as a failed post");
  } catch {
    threw = true;
  }
  assert(!threw, "the poster never throws");
}

finish();
