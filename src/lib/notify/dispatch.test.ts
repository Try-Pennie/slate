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

// alert_state stands in as a real in-memory key -> last_sent_at store rather than
// a fixed shape, so the #1133 recovery tests can actually observe rows appearing
// and being cleared instead of asserting against their own mock. Empty by default,
// which is "no prior send", so the cooldown never blocks the older tests.
const rows = vi.hoisted(() => new Map<string, string>());
const upsert = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
// #1134: lets a test make every read error, to prove the bulk firing read fails
// closed rather than inventing an answer.
const failReads = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({
            data: rows.has(key) ? { last_sent_at: rows.get(key) } : null,
          }),
        }),
        // The bulk firing-marker read (#1134).
        in: async (_col: string, keys: string[]) =>
          failReads.value
            ? { data: null, error: { message: "read timeout" } }
            : { data: keys.filter((k) => rows.has(k)).map((key) => ({ key })), error: null },
      }),
      upsert: async (row: { key: string; last_sent_at: string }) => {
        upsert(row);
        rows.set(row.key, row.last_sent_at);
        return {};
      },
      delete: () => ({
        eq: async (_col: string, key: string) => {
          del(key);
          rows.delete(key);
          return {};
        },
      }),
    }),
  }),
}));

// #1035: a failed send logs a warning (the paging channel can't page about itself).
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: (...a: unknown[]) => warn(...a) } }));

import {
  sendThrottledInfo,
  sendThrottledAlert,
  resolveAlert,
  isAlertFiring,
  firingAlertKeys,
  firingKey,
} from "./dispatch";
import { slackInfoChannel } from "@/lib/env";
import { __clearChannelCache } from "@/lib/notify/channels";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  failReads.value = false;
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
  // The cooldown row, picked by key: a successful send also writes the #1133
  // firing marker, so the cooldown stamp is no longer simply the first call.
  const stampedMs = (key: string) =>
    Date.parse(
      (
        upsert.mock.calls
          .map((c) => c[0] as { key: string; last_sent_at: string })
          .find((r) => r.key === key) as { last_sent_at: string }
      ).last_sent_at,
    );

  it("on a successful send: stamps ~now (full cooldown applies) and does not warn", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    const before = Date.now();
    await sendThrottledAlert("k1", COOLDOWN, "hello");
    const after = Date.now();

    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(stampedMs("k1")).toBeGreaterThanOrEqual(before - 1000);
    expect(stampedMs("k1")).toBeLessThanOrEqual(after + 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("on a FAILED send: warns and stamps so a retry is due in ~2 min, not a full cooldown later", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    const before = Date.now();
    await sendThrottledAlert("k2", COOLDOWN, "hello");

    expect(warn).toHaveBeenCalledTimes(1);
    // next-eligible = stamp + cooldown should land ~now + 2min, far below the
    // full-cooldown horizon, proving the alert is not silently muted.
    const nextEligible = stampedMs("k2") + COOLDOWN;
    expect(nextEligible).toBeLessThan(before + 5 * 60 * 1000);
    expect(nextEligible).toBeGreaterThanOrEqual(before + 60 * 1000);
  });
});

// #1133: an actionable page must say when it clears. Silence is indistinguishable
// from the cooldown still running, so a cleared condition sends a recovery notice
// exactly once, and only when a page was actually DELIVERED.
describe("resolveAlert recovery notice (#1133)", () => {
  const COOLDOWN = 30 * 60 * 1000;

  it("records a firing marker only when the page was actually delivered", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    expect(rows.has(firingKey("sync_failures"))).toBe(true);

    rows.clear();
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    expect(rows.has(firingKey("sync_failures"))).toBe(false);
  });

  it("no-ops when nothing was firing (never announces a recovery from a page that never fired)", async () => {
    const sent = await resolveAlert("sync_failures", "all better");
    expect(sent).toBe(false);
    expect(slack.postSlack).not.toHaveBeenCalled();
  });

  it("posts the recovery notice and clears both the marker and the cooldown", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    vi.clearAllMocks();

    slack.postSlack.mockResolvedValueOnce({ ok: true });
    const sent = await resolveAlert("sync_failures", "all better");

    expect(sent).toBe(true);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(slack.postSlack.mock.calls[0][0]).toMatchObject({ text: "all better" });
    expect(rows.has(firingKey("sync_failures"))).toBe(false);
    // The cooldown row goes too, so a genuinely NEW incident pages immediately
    // instead of being muted for the remainder of the old cooldown.
    expect(rows.has("sync_failures")).toBe(false);
  });

  it("sends the notice at most once for one incident", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    slack.postSlack.mockResolvedValue({ ok: true });

    expect(await resolveAlert("sync_failures", "all better")).toBe(true);
    expect(await resolveAlert("sync_failures", "all better")).toBe(false);
    expect(await resolveAlert("sync_failures", "all better")).toBe(false);
  });

  // Failure path: a recovery notice that fails to send must be RETRIED, not lost.
  it("keeps the marker and warns when the recovery notice fails to send", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    vi.clearAllMocks();

    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    const sent = await resolveAlert("sync_failures", "all better");

    expect(sent).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rows.has(firingKey("sync_failures"))).toBe(true);

    // ...and the next tick gets it through.
    slack.postSlack.mockResolvedValueOnce({ ok: true });
    expect(await resolveAlert("sync_failures", "all better")).toBe(true);
    expect(rows.has(firingKey("sync_failures"))).toBe(false);
  });

  // #1134: lets a caller skip the (sometimes expensive) work of PROVING health when
  // there is no outstanding page to clear.
  describe("isAlertFiring", () => {
    it("is false before any page and true once one is delivered", async () => {
      expect(await isAlertFiring("sync_failures")).toBe(false);
      slack.postSlack.mockResolvedValueOnce({ ok: true });
      await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
      expect(await isAlertFiring("sync_failures")).toBe(true);
    });

    it("is false again once the condition is resolved", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
      await resolveAlert("sync_failures", "all better");
      expect(await isAlertFiring("sync_failures")).toBe(false);
    });

    it("does not confuse one alert key with another", async () => {
      slack.postSlack.mockResolvedValueOnce({ ok: true });
      await sendThrottledAlert("watch_lapse", COOLDOWN, "broken");
      expect(await isAlertFiring("watch_lapse")).toBe(true);
      expect(await isAlertFiring("sync_failures")).toBe(false);
    });
  });

  // #1134: the lane watchdog asks about ~15 keys on the every-minute lane, and
  // one read each would be 15 extra queries a minute on the tightest budget in
  // the system (the four minute-lanes share one invocation). This answers for the
  // whole set in a single read.
  describe("firingAlertKeys", () => {
    it("returns only the keys that are actually firing", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert("cron_lane_stale:sync", COOLDOWN, "broken");
      await sendThrottledAlert("cron_lane_stale:outbox", COOLDOWN, "broken");

      const firing = await firingAlertKeys([
        "cron_lane_stale:sync",
        "cron_lane_stale:outbox",
        "cron_lane_stale:watch",
      ]);

      expect(firing.has("cron_lane_stale:sync")).toBe(true);
      expect(firing.has("cron_lane_stale:outbox")).toBe(true);
      expect(firing.has("cron_lane_stale:watch")).toBe(false);
      // Answers in the caller's own key space, not the internal marker prefix,
      // so a caller can never accidentally resolve the wrong key.
      expect([...firing].some((k) => k.startsWith("alert_firing:"))).toBe(false);
    });

    it("returns an empty set for no keys without reading at all", async () => {
      const firing = await firingAlertKeys([]);
      expect(firing.size).toBe(0);
    });

    it("returns an empty set when the read fails, so nothing is resolved on a bad query", async () => {
      // Fails CLOSED, matching isAlertFiring: a wrong "not firing" only defers a
      // recovery notice one tick, and the marker survives. A wrong "firing" would
      // be worse, sending callers to prove health they cannot establish.
      failReads.value = true;
      const firing = await firingAlertKeys(["cron_lane_stale:sync"]);
      expect(firing.size).toBe(0);
    });
  });

  it("no-ops when Slack is unconfigured", async () => {
    rows.set(firingKey("sync_failures"), new Date().toISOString());
    slack.slackConfigured.mockReturnValueOnce(false);
    expect(await resolveAlert("sync_failures", "all better")).toBe(false);
    expect(slack.postSlack).not.toHaveBeenCalled();
    // The marker survives, so the notice still goes out once Slack is configured.
    expect(rows.has(firingKey("sync_failures"))).toBe(true);
  });
});
