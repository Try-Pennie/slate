import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #567: the low-priority info path. sendThrottledInfo must post to the info
// channel (never the alerts channel) and no-op when no channel is configured;
// slackInfoChannel() must fall back to the alerts channel so the signal is not
// silently lost. Slack + Supabase are mocked so nothing hits the network/DB.

const slack = vi.hoisted(() => ({
  postSlack: vi.fn(
    async (
      _msg: { text: string; channel?: string },
    ): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> => ({
      ok: true,
    }),
  ),
  slackConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/notify/slack", () => slack);

// alert_state: no prior send (so the cooldown never blocks), and a spyable upsert
// so the #1035 tests can inspect the stamped last_sent_at.
const upsert = vi.hoisted(() => vi.fn(async (_row: unknown) => ({})));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert,
    }),
  }),
}));

// #1035: a failed send logs a warning (the paging channel can't page about itself).
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: (...a: unknown[]) => warn(...a) } }));

import { sendThrottledInfo, sendThrottledAlert } from "./dispatch";
import { slackInfoChannel } from "@/lib/env";
import { __clearChannelCache } from "@/lib/notify/channels";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV };
  // #571: the info channel now comes from a store-aware, briefly-cached resolver;
  // clear it so each test's env is honored (the mocked config table is empty).
  __clearChannelCache();
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

describe("sendThrottledAlert delivery-aware cooldown (#1035)", () => {
  const COOLDOWN = 30 * 60 * 1000;
  const stampedMs = () =>
    Date.parse((upsert.mock.calls[0][0] as { last_sent_at: string }).last_sent_at);

  it("on a successful send: stamps ~now (full cooldown applies) and does not warn", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    const before = Date.now();
    await sendThrottledAlert("k1", COOLDOWN, "hello");
    const after = Date.now();

    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(stampedMs()).toBeGreaterThanOrEqual(before - 1000);
    expect(stampedMs()).toBeLessThanOrEqual(after + 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("on a FAILED send: warns and stamps so a retry is due in ~2 min, not a full cooldown later", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    const before = Date.now();
    await sendThrottledAlert("k2", COOLDOWN, "hello");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    // next-eligible = stamp + cooldown should land ~now + 2min, far below the
    // full-cooldown horizon, proving the alert is not silently muted.
    const nextEligible = stampedMs() + COOLDOWN;
    expect(nextEligible).toBeLessThan(before + 5 * 60 * 1000);
    expect(nextEligible).toBeGreaterThanOrEqual(before + 60 * 1000);
  });
});
