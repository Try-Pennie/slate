import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { idFilterBytes, MAX_IN_FILTER_BYTES } from "@/lib/db/id-batch";

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

// #1537: every dispatcher that WRITES is gated on actually running on the Workers runtime.
// Defaults to true here so every existing case still asserts production behaviour; the
// off-platform cases set it false explicitly.
const isWorkersRuntime = vi.hoisted(() => vi.fn(() => true));
const workersRuntimeMarker = vi.hoisted(() => () => "Cloudflare-Workers");
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime, workersRuntimeMarker }));

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
// #2542: the per key cooldown read, which fails toward SENDING.
const failCooldownRead = vi.hoisted(() => ({ value: false }));
// The bulk delete behind settleAlertsSilently: the batch sizes it was asked for
// (the ids ride in the URL, so an unchunked 60-key delete is the PR#1251 defect),
// plus a switch to make the delete itself fail.
const delIn = vi.hoisted(() => vi.fn());
// #2756: every key list the bulk existence read was asked for, one entry per
// request, so a test can assert each request's URL size rather than trusting a
// fake that happily accepts any length. `failReadInCall` refuses exactly the Nth
// request (1-based), which is the partial failure a chunked read can meet.
const readIn = vi.hoisted(() => vi.fn());
const failReadInCall = vi.hoisted(() => ({ value: 0 }));
const failDeletes = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          // #2542: a switch for the COOLDOWN read failing, so the `// error-ok:`
          // on it is proved rather than asserted. supabase-js resolves a refused
          // statement as `{ data: null, error }`, which is what this returns.
          maybeSingle: async () =>
            failCooldownRead.value
              ? { data: null, error: { message: "statement timeout" } }
              : { data: rows.has(key) ? { last_sent_at: rows.get(key) } : null, error: null },
        }),
        // The family read (#2593): a LIKE over the firing markers. It honours a
        // `.limit(n)` and an ordered `.range(from, to)` the way PostgREST does, so a
        // family bigger than one page is truncated by a single capped read exactly
        // as production would truncate it (#2726).
        like: (_col: string, pattern: string) => {
          const matching = () => {
            const prefix = pattern.replace(/%$/, "").replace(/\\_/g, "_");
            return [...rows.keys()]
              .filter((k) => k.startsWith(prefix))
              .sort()
              .map((key) => ({ key }));
          };
          const refused = { data: null, error: { message: "read timeout" } };
          return {
            limit: async (n: number) =>
              failReads.value ? refused : { data: matching().slice(0, Math.min(n, 1000)), error: null },
            order: () => ({
              range: async (from: number, to: number) =>
                failReads.value
                  ? refused
                  : { data: matching().slice(from, Math.min(to + 1, from + 1000)), error: null },
            }),
          };
        },
        // The bulk firing-marker read (#1134).
        in: async (_col: string, keys: string[]) => {
          readIn(keys);
          return failReads.value || readIn.mock.calls.length === failReadInCall.value
            ? { data: null, error: { message: "read timeout" } }
            : { data: keys.filter((k) => rows.has(k)).map((key) => ({ key })), error: null };
        },
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
        in: async (_col: string, keys: string[]) => {
          delIn(keys);
          if (failDeletes.value) return { error: { message: "delete timeout" } };
          for (const k of keys) rows.delete(k);
          return { error: null };
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
  existingAlertStateKeys,
  resolveRecovered,
  firingFamilyMembers,
  firingKey,
  settleAlertsSilently,
  isAlertDue,
} from "./dispatch";
import { slackInfoChannel } from "@/lib/env";
import { __clearChannelCache } from "@/lib/notify/channels";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  failReads.value = false;
  failReadInCall.value = 0;
  failDeletes.value = false;
  isWorkersRuntime.mockReturnValue(true);
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

  it("still sends when the stored cooldown stamp is unparseable (#1169)", async () => {
    // A corrupt last_sent_at used to parse to NaN, which shouldSendAlert compared
    // false against forever: the alert was permanently muted with nothing knowing.
    // Unreadable must land on the SEND side (as if never sent), and the send then
    // overwrites the corrupt stamp with a fresh one.
    // No mockResolvedValueOnce here: the default postSlack mock returns ok, and a
    // queued once-value would leak into the next test while this send is muted.
    rows.set("k3", "not-a-timestamp");
    await sendThrottledAlert("k3", COOLDOWN, "hello");
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
  });

  // 2026-09-24: `catchall_rate` was missing from ALERT_KEYS, so its cooldown
  // resolved to undefined. With no cooldown the check said "send", Slack got the
  // page, and only THEN did the stamp throw "Invalid time value", so nothing was
  // recorded and every 5 minute tick sent it again. The refusal has to come
  // before the post, or the page repeats forever while the step reports failing.
  for (const bad of [undefined, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    it(`refuses a cooldown of ${String(bad)} by name, before posting anything`, async () => {
      await expect(
        sendThrottledAlert("k4", bad as unknown as number, "hello"),
      ).rejects.toThrow(/k4 has no usable cooldown/);
      expect(slack.postSlack).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });
  }
});

// #3104: the load run's fault pass is judged on whether a page WOULD have gone out,
// once per cooldown. Slack refuses every load test post (#2335) and the deployment
// holds no bot token, so before this nothing about a page left any trace the judge
// could read. Under the flag the throttle runs and the page is recorded instead.
describe("sendThrottledAlert under a load test (#3104)", () => {
  const COOLDOWN = 30 * 60 * 1000;

  it("records the page in alert_state and posts nothing, with no bot token", async () => {
    process.env.SLATE_LOADTEST = "true";
    slack.slackConfigured.mockReturnValue(false);
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(rows.has("sync_failures")).toBe(true);
    // Nobody was told, so no all clear is owed (#1133).
    expect(rows.has(firingKey("sync_failures"))).toBe(false);
  });

  it("is THROTTLED: a second page inside the cooldown records nothing new", async () => {
    process.env.SLATE_LOADTEST = "true";
    slack.slackConfigured.mockReturnValue(false);
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    const first = rows.get("sync_failures");
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken again");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(rows.get("sync_failures")).toBe(first);
  });

  it("stamps the full cooldown, so the record reads as a page that went out", async () => {
    process.env.SLATE_LOADTEST = "true";
    slack.slackConfigured.mockReturnValue(false);
    const before = Date.now();
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    const stamped = Date.parse(rows.get("sync_failures")!);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("off the flag, an unconfigured Slack still records nothing (production is unchanged)", async () => {
    delete process.env.SLATE_LOADTEST;
    slack.slackConfigured.mockReturnValue(false);
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    expect(upsert).not.toHaveBeenCalled();
    expect(slack.postSlack).not.toHaveBeenCalled();
    slack.slackConfigured.mockReturnValue(true);
  });

  it("never records from off the Workers runtime, flag or not", async () => {
    process.env.SLATE_LOADTEST = "true";
    slack.slackConfigured.mockReturnValue(false);
    isWorkersRuntime.mockReturnValue(false);
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
    expect(upsert).not.toHaveBeenCalled();
    slack.slackConfigured.mockReturnValue(true);
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

  // #2756: the off site origin check asks about one key per recent booking, so the
  // list grows with booking volume, and the keys ride in the request URL. One
  // unchunked filter past PostgREST's URL ceiling is REFUSED, not truncated.
  describe("existingAlertStateKeys", () => {
    // A realistic key: the off site origin family keyed by a booking uuid. 400 of
    // them is far past the measured refusal (about 14.9 KB for 400 bare uuids).
    const bookingKey = (i: number) =>
      `booking_offsite_origin:${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const many = Array.from({ length: 400 }, (_, i) => bookingKey(i));

    it("splits a long key list so no request exceeds the URL budget, and merges every chunk", async () => {
      // Positive control on the premise: the whole list in one filter is over budget.
      expect(idFilterBytes(many)).toBeGreaterThan(MAX_IN_FILTER_BYTES);
      // Present keys at the start, the middle and the very end, so a merge that
      // kept only the first or last chunk is caught.
      for (const k of [many[0], many[200], many[399]]) rows.set(k, new Date().toISOString());

      const present = await existingAlertStateKeys(many);

      const requests = readIn.mock.calls.map(([batch]) => batch as string[]);
      expect(requests.length).toBeGreaterThan(1);
      for (const batch of requests) expect(idFilterBytes(batch)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
      // Every key asked about exactly once, none dropped at a chunk boundary.
      expect(requests.flat()).toEqual(many);
      expect([...present].sort()).toEqual([many[0], many[200], many[399]].sort());
    });

    it("sends a short list as one request", async () => {
      await existingAlertStateKeys(["a", "b"]);
      expect(readIn).toHaveBeenCalledTimes(1);
    });

    it("throws when any one chunk is refused, rather than answering with the chunks that worked", async () => {
      // The first chunk holds a present key, so a merge that skipped the failed
      // chunk would return a plausible, non-empty, SHORT answer (L215).
      rows.set(many[0], new Date().toISOString());
      failReadInCall.value = 2;
      await expect(existingAlertStateKeys(many)).rejects.toThrow(/read timeout/);
    });

    it("resolveRecovered resolves nothing and SAYS so when the read is refused", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert("cron_lane_stale:sync", COOLDOWN, "broken");
      slack.postSlack.mockClear();
      warn.mockClear();
      failReads.value = true;
      await expect(resolveRecovered([{ key: "cron_lane_stale:sync", text: "ok now" }])).resolves.toEqual([]);
      expect(slack.postSlack).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "slack-alert",
        expect.objectContaining({ msg: expect.stringContaining("alert-state key read failed") }),
        expect.any(Error),
      );
    });

    it("throws on a refused single request too, so the caller can say the read failed", async () => {
      failReads.value = true;
      await expect(existingAlertStateKeys(["cron_lane_stale:sync"])).rejects.toThrow(/read timeout/);
    });
  });

  // #2593: a per booking family whose members cannot be enumerated from anywhere
  // else, because a cancelled booking drops out of every read that would name it.
  describe("firingFamilyMembers", () => {
    it("returns the member ids of a family that is firing, and nothing from its neighbours", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert("booking_below_lead_tier:bk-1", COOLDOWN, "below");
      await sendThrottledAlert("booking_below_lead_tier:bk-2", COOLDOWN, "below");
      await sendThrottledAlert("booking_below_lead_tierX:bk-3", COOLDOWN, "a lookalike family");
      await sendThrottledAlert("sync_failures", COOLDOWN, "broken");

      const members = await firingFamilyMembers("booking_below_lead_tier");
      expect(members.sort()).toEqual(["bk-1", "bk-2"]);
    });

    it("forgets a member once it is resolved", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert("booking_below_lead_tier:bk-1", COOLDOWN, "below");
      await resolveAlert("booking_below_lead_tier:bk-1", "fine now");
      expect(await firingFamilyMembers("booking_below_lead_tier")).toEqual([]);
    });

    it("reads EVERY member of a family bigger than one PostgREST page (#2726)", async () => {
      // A capped single read returns the first 1,000 and stops, so the members past
      // it would never be cleared and the family would read as smaller than it is.
      const ids = Array.from({ length: 2345 }, (_, i) => `bk-${String(i).padStart(5, "0")}`);
      for (const id of ids) rows.set(firingKey(`booking_below_lead_tier:${id}`), new Date().toISOString());
      const members = await firingFamilyMembers("booking_below_lead_tier");
      expect(members.length).toBe(ids.length);
      expect(new Set(members)).toEqual(new Set(ids));
    });

    it("THROWS when the read fails, so a caller can never clear off a list it did not get", async () => {
      failReads.value = true;
      await expect(firingFamilyMembers("booking_below_lead_tier")).rejects.toThrow(/alert_state/);
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

// settleAlertsSilently: drop several superseded pages WITHOUT a notice each.
// Built for the empty-bucket sweep folding sixty per-bucket pages into one
// aggregate page: resolving them normally would post sixty all-clears to announce
// that sixty pages became one, which is the flood it exists to stop.
describe("settleAlertsSilently", () => {
  it("drops both the firing marker and the cooldown row, and posts nothing", async () => {
    rows.set(firingKey("empty_buckets:411"), "2026-08-05T00:00:00.000Z");
    rows.set("empty_buckets:411", "2026-08-05T00:00:00.000Z");
    rows.set(firingKey("empty_buckets:412"), "2026-08-05T00:00:00.000Z");

    await settleAlertsSilently(["empty_buckets:411", "empty_buckets:412"]);

    // The marker has to go, or a later recovery notice fires for a page the reader
    // was never left holding. The cooldown row too, so a genuinely new page is not
    // muted by the old one's remaining cooldown.
    expect(rows.has(firingKey("empty_buckets:411"))).toBe(false);
    expect(rows.has("empty_buckets:411")).toBe(false);
    expect(rows.has(firingKey("empty_buckets:412"))).toBe(false);
    // Silent is the whole point: the replacement page is the notice.
    expect(slack.postSlack).not.toHaveBeenCalled();
  });

  it("touches nothing when given no keys", async () => {
    await settleAlertsSilently([]);
    expect(delIn).not.toHaveBeenCalled();
  });

  it("chunks the delete so no request exceeds the URL budget", async () => {
    // Asserted in BYTES, which is what PostgREST actually refuses on (#1321). A
    // row-count assertion is satisfied by any count, including one carried over
    // from a call site whose keys were shorter, which is how this class shipped
    // broken three times. 300 keys become 600 rows (marker plus cooldown).
    const keys = Array.from({ length: 300 }, (_, i) => `empty_buckets:b${i}`);
    await settleAlertsSilently(keys);
    const batches = delIn.mock.calls.map(([batch]) => batch as string[]);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(idFilterBytes(batch)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    }
    expect(batches.reduce((a, b) => a + b.length, 0)).toBe(600);
  });

  it("packs fewer long keys per request than short ones, since bytes are what count", async () => {
    // The property that made a shared row count wrong: the same count is legal for
    // short keys and illegal for long ones.
    const short = Array.from({ length: 300 }, (_, i) => `s:${i}`);
    await settleAlertsSilently(short);
    const shortBatches = delIn.mock.calls.length;
    delIn.mockClear();
    const long = Array.from({ length: 300 }, (_, i) => `s:${i}:${"x".repeat(160)}`);
    await settleAlertsSilently(long);
    expect(delIn.mock.calls.length).toBeGreaterThan(shortBatches);
  });

  it("logs and keeps going when the delete fails, rather than failing silently", async () => {
    // A marker left behind is the flood again on the next sweep, so the failure has
    // to be visible somewhere. It still must not throw: this rides a monitoring
    // path that must never fail the lane it runs on.
    failDeletes.value = true;
    rows.set(firingKey("empty_buckets:411"), "2026-08-05T00:00:00.000Z");

    await expect(settleAlertsSilently(["empty_buckets:411"])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    const fields = warn.mock.calls[0][1] as { msg: string };
    expect(fields.msg).toMatch(/settle/i);
    // Nothing was deleted, so the next sweep sees the marker and tries again.
    expect(rows.has(firingKey("empty_buckets:411"))).toBe(true);
  });
});

describe("off the Workers runtime, a write dispatcher does nothing (#1537)", () => {
  // WHY. `.env.local` points a dev server at the LIVE Supabase project and the LIVE Slack
  // channel, so anything a laptop raises reaches whoever is on call. On 2026-08-17 that cost
  // an afternoon: a rate-limiter page claimed the only abuse control on the public
  // availability endpoint was off, and production's limiter had been enforcing correctly the
  // whole time. #1530 gated that ONE alert. This is the class (L30).
  //
  // There are two harms and the second is quieter. A dev server also WRITES alert_state, so
  // it burns the cooldown: a genuine production occurrence inside that window is then
  // silently suppressed. And a dev server calling resolveAlert can CLEAR a real page, which
  // is worse than raising a false one.
  //
  // This gates the WRITES only. Reads stay open, because reading from a laptop is useful and
  // harms nothing.

  beforeEach(() => {
    isWorkersRuntime.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    __clearChannelCache();
  });

  it("does not post a page, and does not touch the cooldown", async () => {
    await sendThrottledAlert("some_key", 60_000, "a page from a laptop");

    expect(slack.postSlack).not.toHaveBeenCalled();
    // The second harm: writing the stamp here would mute the real alert for a full cooldown.
    expect(upsert).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("does not post an info notice either", async () => {
    process.env.SLACK_INFO_CHANNEL = "#info";
    __clearChannelCache();
    await sendThrottledInfo("some_key", 60_000, "a whisper from a laptop");

    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does NOT clear a live production page", async () => {
    // The worst of the three. A laptop announcing that a real, still-broken condition has
    // recovered is worse than a laptop raising a false one: the page goes away and the
    // condition does not.
    rows.set(firingKey("some_key"), new Date().toISOString());
    rows.set("some_key", new Date().toISOString());

    await resolveAlert("some_key", "all clear from a laptop");

    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(rows.has(firingKey("some_key"))).toBe(true);
    expect(rows.has("some_key")).toBe(true);
  });

  it("says so in the logs, so it is never silent, and names the alert it withheld", async () => {
    await sendThrottledAlert("some_key", 60_000, "a page from a laptop");
    const lines = JSON.stringify(warn.mock.calls);
    expect(lines).toMatch(/not running on the Cloudflare runtime/i);
    // The key, so a developer can see WHICH alert their local run would have sent.
    expect(lines).toMatch(/some_key/);
  });

  it("still sends when an operator deliberately opts in", async () => {
    // An escape hatch for testing alert wiring from a laptop on purpose. Off by default,
    // because the default has to be the safe one: forgetting to set it produces silence, and
    // forgetting to UNSET it is the state this whole issue is about (L72).
    process.env.SLATE_ALLOW_OFFPLATFORM_ALERTS = "1";
    await sendThrottledAlert("some_key", 60_000, "a deliberate test page");
    expect(slack.postSlack).toHaveBeenCalled();
  });

  it("leaves READS alone, so a laptop can still inspect alert state", async () => {
    rows.set(firingKey("some_key"), new Date().toISOString());
    await expect(isAlertFiring("some_key")).resolves.toBe(true);
  });
});

// PR #2883: the race whisper asks this before paging through a fortnight of
// bookings, so the question must be answered exactly as the send answers it.
describe("isAlertDue", () => {
  const NOW = Date.parse("2026-09-29T15:00:00.000Z");
  const HOUR = 60 * 60_000;
  afterEach(() => {
    failCooldownRead.value = false;
  });

  it("is due when the key was never sent", async () => {
    expect(await isAlertDue("race_key", 24 * HOUR, NOW)).toBe(true);
  });

  it("is NOT due while the cooldown from the last send is still running", async () => {
    rows.set("race_key", new Date(NOW - HOUR).toISOString());
    expect(await isAlertDue("race_key", 24 * HOUR, NOW)).toBe(false);
  });

  it("is due again once the cooldown has elapsed", async () => {
    rows.set("race_key", new Date(NOW - 25 * HOUR).toISOString());
    expect(await isAlertDue("race_key", 24 * HOUR, NOW)).toBe(true);
  });

  it("is due when the row cannot be read, the side the send itself takes", async () => {
    rows.set("race_key", new Date(NOW - HOUR).toISOString());
    failCooldownRead.value = true;
    expect(await isAlertDue("race_key", 24 * HOUR, NOW)).toBe(true);
  });

  it("is due when the stamp is unreadable, as the send treats it", async () => {
    rows.set("race_key", "not a time");
    expect(await isAlertDue("race_key", 24 * HOUR, NOW)).toBe(true);
  });

  it("agrees with the send: a key it calls not due is one the send suppresses", async () => {
    rows.set("race_key", new Date().toISOString());
    expect(await isAlertDue("race_key", 24 * HOUR, Date.now())).toBe(false);
    await sendThrottledAlert("race_key", 24 * HOUR, "x");
    expect(slack.postSlack).not.toHaveBeenCalled();
  });
});

// #2542: the cooldown read carries an `// error-ok:` saying that an empty result
// reads as "never sent", which SENDS. That is the fail safe side, and it had
// never been asserted: this file sat outside the swallowed-read guard's hand
// written directory list, so nothing had asked what a refused `alert_state` read
// does. A lost cooldown costs a duplicate page; a swallowed one MUTES the alert.
describe("the cooldown read failing (#2542)", () => {
  beforeEach(() => {
    failCooldownRead.value = false;
  });
  afterEach(() => {
    failCooldownRead.value = false;
  });

  it("sends anyway when the cooldown row cannot be read", async () => {
    rows.set("muted_key", new Date().toISOString());
    failCooldownRead.value = true;

    await sendThrottledAlert("muted_key", 60 * 60_000, "something is wrong");

    expect(slack.postSlack).toHaveBeenCalled();
  });

  // The CONTROL, so the case above cannot pass by this path sending on
  // everything: the same key, the same fresh stamp, a read that WORKS, and the
  // cooldown holds.
  it("CONTROL: a readable cooldown row inside the window still suppresses", async () => {
    rows.set("muted_key", new Date().toISOString());

    await sendThrottledAlert("muted_key", 60 * 60_000, "something is wrong");

    expect(slack.postSlack).not.toHaveBeenCalled();
  });
});
