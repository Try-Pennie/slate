import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #567: the low-priority info path. sendThrottledInfo must post to the info
// channel (never the alerts channel) and no-op when no channel is configured;
// slackInfoChannel() must fall back to the alerts channel so the signal is not
// silently lost. Slack + Supabase are mocked so nothing hits the network/DB.

const slack = vi.hoisted(() => ({
  postSlack: vi.fn(async (_msg: { text: string; channel?: string }) => ({ ok: true })),
  slackConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/notify/slack", () => slack);

// alert_state: no prior send (so the cooldown never blocks), and a no-op upsert.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert: async () => ({}),
    }),
  }),
}));

import { sendThrottledInfo } from "./dispatch";
import { slackInfoChannel } from "@/lib/env";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = ENV;
});

describe("slackInfoChannel", () => {
  it("uses SLACK_INFO_CHANNEL when set", () => {
    process.env.SLACK_INFO_CHANNEL = "#quiet";
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    expect(slackInfoChannel()).toBe("#quiet");
  });

  it("falls back to the alerts channel when unset (signal never lost)", () => {
    delete process.env.SLACK_INFO_CHANNEL;
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    expect(slackInfoChannel()).toBe("#alerts");
  });

  it("is empty when neither channel is configured", () => {
    delete process.env.SLACK_INFO_CHANNEL;
    delete process.env.SLACK_ALERTS_CHANNEL;
    expect(slackInfoChannel()).toBe("");
  });
});

describe("sendThrottledInfo", () => {
  it("posts the notice to the info channel, not the alerts channel", async () => {
    process.env.SLACK_INFO_CHANNEL = "#quiet";
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledInfo("k", 1000, "thin tier covered");
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(slack.postSlack.mock.calls[0][0]).toMatchObject({
      text: "thin tier covered",
      channel: "#quiet",
    });
  });

  it("no-ops (no Slack post) when no info/alerts channel is configured", async () => {
    delete process.env.SLACK_INFO_CHANNEL;
    delete process.env.SLACK_ALERTS_CHANNEL;
    await sendThrottledInfo("k", 1000, "thin tier covered");
    expect(slack.postSlack).not.toHaveBeenCalled();
  });
});
