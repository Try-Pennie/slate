import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3528 (L757): every message leaves Slate through src/lib/notify/slack.ts, and that is
// where person edited text is escaped, so a sender written tomorrow cannot skip it.
//
// The real instance: an agent's time off reason and notes are typed in Slate and go
// into the manager's notice as written. Posted to the fallback channel, a reason of
// `<!channel>` pinged everybody in it. These drive each send path with that text and
// read what was actually put on the wire.
const APP = "https://slate.trypennie.app";
vi.mock("@/lib/env", () => ({ slackBotToken: () => "xoxb-test", appUrl: () => APP }));

import { dmSlackUserByEmail, postSlack, replyToSlackResponseUrl, updateSlackMessage } from "./slack";

const bodies: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body ?? "");
      bodies.push({ url: String(url), body: raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const reply = String(url).includes("users.lookupByEmail")
        ? { ok: true, user: { id: "U1" } }
        : String(url).includes("conversations.open")
          ? { ok: true, channel: { id: "D1" } }
          : { ok: true, channel: "C1", ts: "1.2" };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const TYPED = "Reason: family <!channel> trip, see <https://evil.example|Review it here>";
const SAFE = "Reason: family &lt;!channel&gt; trip, see &lt;https://evil.example|Review it here&gt;";
const OWN_LINK = `<${APP}/admin/ooo?request=r1|Review it here>`;

describe("the Slack send point escapes what a person typed", () => {
  it("postSlack escapes the text and every mrkdwn block, and keeps Slate's own link", async () => {
    await postSlack({
      channel: "C1",
      text: `${TYPED}\n${OWN_LINK}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: TYPED } }],
    });
    const sent = bodies.find((b) => b.url.endsWith("chat.postMessage"))!.body;
    expect(sent.text).toBe(`${SAFE}\n${OWN_LINK}`);
    expect((sent.blocks as { text: { text: string } }[])[0].text.text).toBe(SAFE);
  });

  it("a DM is escaped the same way", async () => {
    await dmSlackUserByEmail("manager@trypennie.com", TYPED, [{ type: "section", text: { type: "mrkdwn", text: TYPED } }]);
    const sent = bodies.find((b) => b.url.endsWith("chat.postMessage"))!.body;
    expect(sent.text).toBe(SAFE);
    expect((sent.blocks as { text: { text: string } }[])[0].text.text).toBe(SAFE);
  });

  it("an edit of a posted message is escaped the same way", async () => {
    await updateSlackMessage({ channel: "C1", ts: "1.2" }, TYPED);
    expect(bodies.find((b) => b.url.endsWith("chat.update"))!.body.text).toBe(SAFE);
  });

  it("a reply to an interaction is escaped the same way", async () => {
    await replyToSlackResponseUrl("https://hooks.slack.com/actions/T/1/x", TYPED);
    const sent = bodies.find((b) => b.url.startsWith("https://hooks.slack.com/"))!.body;
    expect(sent).toEqual({ response_type: "ephemeral", text: SAFE });
  });
});
