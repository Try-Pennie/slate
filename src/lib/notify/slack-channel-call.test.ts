import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #1957: HOW the channel check is sent, which is not a house style detail.
//
// Slack's write methods take a JSON body and its read methods do not. Measured
// against the live workspace on 2026-09-06, `conversations.info` answered
// `invalid_arguments` to a JSON body for EVERY channel, including a real one the
// bot is a member of, and answered correctly to the same argument form encoded.
//
// That failure is worth a test of its own because it is indistinguishable from
// the finding the caller is looking for: an error string, about the channel, on
// a request that reached Slack and returned 200. Every offline test of the
// mapping passes while the check answers "could not check" for every channel
// forever, which is precisely the blind detector this feature exists not to be.
vi.mock("@/lib/env", () => ({ slackBotToken: () => "xoxb-test" }));

import { fetchSlackChannel, listSlackChannels } from "./slack";

const sent = { url: "", headers: {} as Record<string, string>, body: "" };
const calls: string[] = [];
/** Queued replies, one per fetch, so pagination can be driven. */
let replies: unknown[] = [];

beforeEach(() => {
  sent.url = "";
  sent.headers = {};
  sent.body = "";
  calls.length = 0;
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.url = String(url);
      sent.headers = (init.headers ?? {}) as Record<string, string>;
      sent.body = String(init.body ?? "");
      calls.push(sent.body);
      const next = replies.length
        ? replies.shift()
        : { ok: true, channel: { name: "alerts", is_member: true } };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSlackChannel", () => {
  it("form encodes the channel rather than sending JSON", async () => {
    await fetchSlackChannel("C123");
    expect(sent.url).toBe("https://slack.com/api/conversations.info");
    expect(sent.headers["Content-Type"]).toMatch(/application\/x-www-form-urlencoded/);
    expect(sent.body).toBe("channel=C123");
    expect(sent.body.startsWith("{")).toBe(false);
  });

  it("escapes a channel that would otherwise break the encoding", async () => {
    await fetchSlackChannel("#alerts & more");
    expect(sent.body).toBe("channel=%23alerts+%26+more");
  });

  it("hands back Slack's own reply for the pure mapping to read", async () => {
    const reply = await fetchSlackChannel("C123");
    expect(reply.ok).toBe(true);
    expect((reply.data?.channel as { name: string }).name).toBe("alerts");
  });
});

describe("listSlackChannels", () => {
  const channelsOf = async () => {
    const out = await listSlackChannels();
    if (!out.readable) throw new Error(`expected a readable list, got ${out.why}`);
    return out;
  };

  // ORDER IS INFORMATION. A channel Slate is already in is one an alert can
  // reach today; the rest need an invite first, so they come after.
  it("puts the channels Slate is in first, then by name", async () => {
    replies = [
      {
        ok: true,
        channels: [
          { id: "C3", name: "zebra", is_member: true },
          { id: "C1", name: "beta", is_member: false },
          { id: "C2", name: "alpha", is_member: false },
        ],
      },
    ];
    expect((await channelsOf()).channels.map((c) => c.name)).toEqual(["zebra", "alpha", "beta"]);
  });

  it("follows the cursor across pages, and says the list is whole", async () => {
    replies = [
      { ok: true, channels: [{ id: "C1", name: "a", is_member: true }], response_metadata: { next_cursor: "PAGE2" } },
      { ok: true, channels: [{ id: "C2", name: "b", is_member: true }] },
    ];
    const out = await channelsOf();
    expect(out.channels.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(out.complete).toBe(true);
    expect(calls[1]).toMatch(/cursor=PAGE2/);
  });

  // #2438: AN UNREADABLE LIST SAYS SO. It used to answer an empty list, which a
  // save resolving a typed NAME cannot tell from a workspace with no channel by
  // that name, so it would refuse a real channel claiming it does not exist.
  it("says it could not read the list when Slack refuses", async () => {
    replies = [{ ok: false, error: "missing_scope" }];
    expect(await listSlackChannels()).toEqual({ readable: false, why: "missing_scope" });
  });

  it("keeps the pages it read when a later one fails, and says the list is partial", async () => {
    replies = [
      { ok: true, channels: [{ id: "C1", name: "a", is_member: true }], response_metadata: { next_cursor: "PAGE2" } },
      { ok: false, error: "ratelimited" },
    ];
    const out = await channelsOf();
    expect(out.channels.map((c) => c.id)).toEqual(["C1"]);
    expect(out.complete).toBe(false);
  });

  it("drops a malformed entry rather than inventing an id or a name", async () => {
    replies = [{ ok: true, channels: [{ id: "C1" }, { name: "nameless" }, { id: "C2", name: "ok" }] }];
    expect((await channelsOf()).channels.map((c) => c.id)).toEqual(["C2"]);
  });

  // A CURSOR THAT NEVER ENDS must not loop forever on a page render.
  it("stops after a bounded number of pages, and says the list is partial", async () => {
    replies = Array.from({ length: 9 }, (_, i) => ({
      ok: true,
      channels: [{ id: `C${i}`, name: `c${i}`, is_member: true }],
      response_metadata: { next_cursor: "MORE" },
    }));
    const out = await channelsOf();
    expect(calls.length).toBe(5);
    expect(out.channels.length).toBe(5);
    expect(out.complete).toBe(false);
  });
});
