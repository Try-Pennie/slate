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
// #3801: the repeat rule's columns (subjects, band, opened_at) beside each stamp, so
// a condition reads back what its last post said, as it does against Postgres.
const extras = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const keepExtras = vi.hoisted(() => (key: string, row: Record<string, unknown>) => {
  const { key: _k, last_sent_at: _s, ...rest } = row;
  extras.set(key, { ...(extras.get(key) ?? {}), ...rest });
});
const upsert = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
// #1134: lets a test make every read error, to prove the bulk firing read fails
// closed rather than inventing an answer.
const failReads = vi.hoisted(() => ({ value: false }));
// #2542: the per key cooldown read, which fails toward SENDING.
const failCooldownRead = vi.hoisted(() => ({ value: false }));
// #3303: refuse the single-row read of exactly these keys, so a test can fail the
// firing marker read while the cooldown read beside it still answers.
const failKeyReads = vi.hoisted(() => new Set<string>());
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
// #3170: the conditional writes that claim a send. `enforce` is what Postgres does
// (a primary key refuses a second insert, a filter on the stamp the reader saw
// matches nothing once somebody else moved it); switching it off gives the fake the
// old unconditional behaviour, which is the positive control proving the
// concurrency tests can see a duplicate at all. `casNeverMatches` stands in for a
// stamp filter that never matches for a reason other than a lost race.
const claims = vi.hoisted(() => ({ enforce: true, casNeverMatches: false }));
const inserted = vi.hoisted(() => vi.fn());
// Holds every single-row read until `size` of them have arrived, so two senders
// are guaranteed to have both read the same state before either claims, rather
// than relying on how the microtasks happen to interleave. `afterRead` runs once,
// after the next read, so a test can change the row between a read and the claim.
const readBarrier = vi.hoisted(() => ({
  size: 0,
  waiting: [] as (() => void)[],
  afterRead: null as null | (() => void),
}));
vi.mock("@/lib/supabase/admin", () => {
  // A filter chain that applies on `.select()` or when awaited bare, like a
  // PostgREST builder. Each chain is used one way, so it applies once.
  const filtered = (apply: (filters: [string, string][]) => { data?: unknown; error: unknown }) => {
    const filters: [string, string][] = [];
    const b = {
      eq: (col: string, val: string) => {
        filters.push([col, val]);
        return b;
      },
      select: async () => apply(filters),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(apply(filters)).then(res, rej),
    };
    return b;
  };
  const matches = (filters: [string, string][]) => {
    const key = filters.find(([c]) => c === "key")?.[1];
    if (key === undefined || !rows.has(key)) return null;
    for (const [col, val] of filters) {
      if (col !== "last_sent_at") continue;
      if (claims.casNeverMatches) return null;
      if (claims.enforce && rows.get(key) !== val) return null;
    }
    return key;
  };
  return {
  supabaseAdmin: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          // #2542: a switch for the COOLDOWN read failing, so the `// error-ok:`
          // on it is proved rather than asserted. supabase-js resolves a refused
          // statement as `{ data: null, error }`, which is what this returns.
          maybeSingle: async () => {
            const result = failCooldownRead.value || failKeyReads.has(key)
              ? { data: null, error: { message: "statement timeout" } }
              : { data: rows.has(key) ? { ...(extras.get(key) ?? {}), last_sent_at: rows.get(key) } : null, error: null };
            if (readBarrier.size > 0) {
              await new Promise<void>((release) => {
                readBarrier.waiting.push(release);
                if (readBarrier.waiting.length >= readBarrier.size) {
                  readBarrier.size = 0;
                  for (const r of readBarrier.waiting.splice(0)) r();
                }
              });
            }
            const hook = readBarrier.afterRead;
            readBarrier.afterRead = null;
            hook?.();
            return result;
          },
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
          // The keyset filter a paged read cuts each later page with (2026-10-25).
          let after: string | null = null;
          const ordered = {
            range: async (from: number, to: number) =>
              failReads.value
                ? refused
                : {
                    data: matching()
                      .filter((r) => after === null || r.key > after)
                      .slice(from, Math.min(to + 1, from + 1000)),
                    error: null,
                  },
          };
          const paged = {
            gt: (_c: string, v: string) => ((after = v), paged),
            order: () => ordered,
          };
          return {
            limit: async (n: number) =>
              failReads.value ? refused : { data: matching().slice(0, Math.min(n, 1000)), error: null },
            ...paged,
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
      upsert: async (row: { key: string; last_sent_at: string } & Record<string, unknown>) => {
        upsert(row);
        rows.set(row.key, row.last_sent_at);
        keepExtras(row.key, row);
        return {};
      },
      insert: async (row: { key: string; last_sent_at: string } & Record<string, unknown>) => {
        inserted(row);
        if (claims.enforce && rows.has(row.key)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.set(row.key, row.last_sent_at);
        extras.delete(row.key);
        keepExtras(row.key, row);
        return { error: null };
      },
      update: (values: { last_sent_at: string } & Record<string, unknown>) =>
        filtered((filters) => {
          const key = matches(filters);
          if (key === null) return { data: [], error: null };
          rows.set(key, values.last_sent_at);
          keepExtras(key, values);
          return { data: [{ key }], error: null };
        }),
      delete: () => ({
        eq: (col: string, val: string) =>
          filtered((more) => {
            const filters: [string, string][] = [[col, val], ...more];
            const key = matches(filters);
            if (key === null) return { data: [], error: null };
            del(key);
            rows.delete(key);
            extras.delete(key);
            return { data: [{ key }], error: null };
          }),
        in: async (_col: string, keys: string[]) => {
          delIn(keys);
          if (failDeletes.value) return { error: { message: "delete timeout" } };
          for (const k of keys) {
            rows.delete(k);
            extras.delete(k);
          }
          return { error: null };
        },
      }),
    }),
  }),
  };
});

// #1035: a failed send logs a warning (the paging channel can't page about itself).
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: (...a: unknown[]) => warn(...a), info: () => {} } }));

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
  postedConditionSubjects,
  settleAlertsSilently,
  isAlertDue,
} from "./dispatch";
import { slackInfoChannel } from "@/lib/env";
import { signatureSubjects } from "@/lib/notify/repeat-policy";
import { clearChannelCache } from "@/lib/notify/channels";
import { SEVERITY_LEADS } from "@/lib/notify/severity-lead";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  extras.clear();
  failReads.value = false;
  failKeyReads.clear();
  failReadInCall.value = 0;
  failDeletes.value = false;
  claims.enforce = true;
  claims.casNeverMatches = false;
  readBarrier.size = 0;
  readBarrier.waiting.length = 0;
  readBarrier.afterRead = null;
  isWorkersRuntime.mockReturnValue(true);
  process.env = { ...ENV };
  // #571: the info channel now comes from a store-aware, briefly-cached resolver;
  // clear it so each test's env is honored (the mocked config table is empty).
  clearChannelCache();
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
      text: `${SEVERITY_LEADS.whisper}\nthin tier covered`,
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

// #1825: a page and a whisper landed in one channel looking identical. A whisper, an
// all clear and an urgent page open with a lead line naming their severity, and an
// ordinary page opens with its own text (Dan, 2026-10-25), so the two read differently
// whatever channel they reach. Asserted at the transport, since that is what the reader sees.
describe("severity lead on every post but an ordinary page (#1825)", () => {
  const firstLine = (call: number) => slack.postSlack.mock.calls[call][0].text.split("\n")[0];

  it("a page needing attention has no lead and is posted as its own text", async () => {
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledAlert("sync_failures", 1000, "2 agents failing");
    expect(slack.postSlack.mock.calls[0][0].text).toBe("2 agents failing");
  });

  it("an urgent condition opens with the urgent lead", async () => {
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledAlert("empty_tier:low", 1000, "Low tier offers nothing");
    expect(firstLine(0)).toBe(SEVERITY_LEADS.urgent);
  });

  it("a whisper opens with the no action lead, even when the info channel falls back to the alerts channel", async () => {
    delete process.env.SLACK_INFO_CHANNEL;
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledAlert("sync_failures", 1000, "page");
    await sendThrottledInfo("thin_tier", 1000, "thin tier");
    expect(slack.postSlack.mock.calls[1][0].channel).toBe("#alerts");
    expect(firstLine(1)).toBe(SEVERITY_LEADS.whisper);
    expect(firstLine(0)).not.toBe(firstLine(1));
  });

  it("an all clear opens with the resolved lead", async () => {
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledAlert("sync_failures", 1000, "broken");
    await resolveAlert("sync_failures", "fixed");
    expect(slack.postSlack.mock.calls[1][0].text).toBe(`${SEVERITY_LEADS.resolved}\nfixed`);
  });

  it("the lead is not part of what the repeat rule compares, so it never reads as a change", async () => {
    process.env.SLACK_ALERTS_CHANNEL = "#alerts";
    await sendThrottledAlert("sync_failures", 1000, "same fact");
    expect(extras.get("sync_failures")?.subjects).toEqual(signatureSubjects("same fact"));
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
    // The same message: under #3801 a message naming something new is a CHANGE for a
    // condition, and posts at once, so throttling is asserted on an unchanged one.
    await sendThrottledAlert("sync_failures", COOLDOWN, "broken");
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

// #3303: a page whose content holds something the last DELIVERED page could not
// have carried goes out at once, inside the cooldown. On 2026-10-05 the coverage
// give up page said 1 appointment and the other give ups landed inside its
// cooldown, so the reader acted on a number that was already wrong and was never
// told. A page with nothing new still waits the cooldown out.
describe("a page that carries news (#3303)", () => {
  const COOLDOWN = 60 * 60 * 1000;
  const KEY = "coverage_needs_human";
  /** A page delivered `agoMs` ago: both rows carry the same stamp, as a delivered send leaves them. */
  const deliveredAgo = (agoMs: number): number => {
    const at = Date.now() - agoMs;
    const iso = new Date(at).toISOString();
    rows.set(KEY, iso);
    rows.set(firingKey(KEY), iso);
    // #3801: what that page said, so a page naming the same thing is not a change.
    extras.set(KEY, { subjects: signatureSubjects("2 appointments"), band: null, opened_at: iso });
    return at;
  };

  it("re-pages inside the cooldown when something became true after the last delivered page", async () => {
    const paged = deliveredAgo(5 * 60_000);
    await sendThrottledAlert(KEY, COOLDOWN, "4 appointments", { news: {
      newestMs: paged + 60_000,
      asOfMs: Date.now() - 1_000,
    } });
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(slack.postSlack.mock.calls[0][0]).toMatchObject({ text: "4 appointments" });
  });

  it("stays throttled when nothing is newer than the last delivered page", async () => {
    const paged = deliveredAgo(5 * 60_000);
    await sendThrottledAlert(KEY, COOLDOWN, "2 appointments", { news: {
      newestMs: paged,
      asOfMs: Date.now() - 1_000,
    } });
    await sendThrottledAlert(KEY, COOLDOWN, "2 appointments", { news: {
      newestMs: paged - 10 * 60_000,
      asOfMs: Date.now() - 1_000,
    } });
    expect(slack.postSlack).not.toHaveBeenCalled();
  });

  // The anchor a later page compares against is when this page's content was
  // MEASURED, not when it was posted: anything that became true between the read
  // and the post is not in this page, so it has to count as news next time.
  it("stamps both rows with when the content was measured, so a later fact can be told apart", async () => {
    const asOfMs = Date.now() - 2_000;
    await sendThrottledAlert(KEY, COOLDOWN, "2 appointments", { news: { newestMs: asOfMs - 60_000, asOfMs } });
    expect(rows.get(KEY)).toBe(new Date(asOfMs).toISOString());
    expect(rows.get(firingKey(KEY))).toBe(new Date(asOfMs).toISOString());

    // A fact that became true after the measurement and before the post is news.
    await sendThrottledAlert(KEY, COOLDOWN, "3 appointments", { news: {
      newestMs: asOfMs + 500,
      asOfMs: Date.now(),
    } });
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
    // And once told, the same fact is not news again.
    await sendThrottledAlert(KEY, COOLDOWN, "3 appointments", { news: {
      newestMs: asOfMs + 500,
      asOfMs: Date.now(),
    } });
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
  });

  it("never stamps a measurement time later than now", async () => {
    const before = Date.now();
    await sendThrottledAlert(KEY, COOLDOWN, "2 appointments", { news: {
      newestMs: before - 60_000,
      asOfMs: before + 10 * 60_000,
    } });
    expect(Date.parse(rows.get(KEY)!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(rows.get(firingKey(KEY))!)).toBeLessThanOrEqual(Date.now());
  });

  // A failed send leaves a short retry hold (#1035). News must not cut through it,
  // or a hard down Slack is hit on every tick and the hold that stops two
  // overlapping runs posting twice (#3170) stops holding.
  it("does not cut through the retry hold a failed send left", async () => {
    const paged = deliveredAgo(5 * 60_000);
    // Not a queued once-value: if the first send were held back, a queued failure
    // would leak into whichever test posts next and fail it for no reason of its own.
    slack.postSlack.mockImplementation(async () => ({ ok: false, error: "channel_not_found" }));
    try {
      await sendThrottledAlert(KEY, COOLDOWN, "3 appointments", { news: {
        newestMs: paged + 60_000,
        asOfMs: Date.now() - 1_000,
      } });
    } finally {
      slack.postSlack.mockImplementation(async () => ({ ok: true }));
    }
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    await sendThrottledAlert(KEY, COOLDOWN, "3 appointments", { news: {
      newestMs: paged + 60_000,
      asOfMs: Date.now(),
    } });
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
  });

  it("posts news once between two overlapping runs that read the same rows", async () => {
    const paged = deliveredAgo(5 * 60_000);
    readBarrier.size = 2;
    const news = { newestMs: paged + 60_000, asOfMs: Date.now() - 1_000 };
    await Promise.all([
      sendThrottledAlert(KEY, COOLDOWN, "4 appointments", { news }),
      sendThrottledAlert(KEY, COOLDOWN, "4 appointments", { news }),
    ]);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
  });

  // Unable to read when the last page was delivered is unable to say what is
  // new, so the ordinary cooldown decides: the page still repeats on it, and the
  // failure is said out loud rather than skipped in silence.
  it("falls back to the cooldown, and says so, when the delivered marker cannot be read", async () => {
    const paged = deliveredAgo(5 * 60_000);
    failKeyReads.add(firingKey(KEY));
    await sendThrottledAlert(KEY, COOLDOWN, "4 appointments", { news: {
      newestMs: paged + 60_000,
      asOfMs: Date.now() - 1_000,
    } });
    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "slack-alert",
      expect.objectContaining({ key: KEY, msg: expect.stringMatching(/delivered page could not be read/) }),
    );
  });

  it("without news, a page inside the cooldown is held even though a later fact exists", async () => {
    deliveredAgo(5 * 60_000);
    await sendThrottledAlert(KEY, COOLDOWN, "4 appointments");
    expect(slack.postSlack).not.toHaveBeenCalled();
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
    expect(slack.postSlack.mock.calls[0][0]).toMatchObject({ text: `${SEVERITY_LEADS.resolved}\nall better` });
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

  // #4392: a summary condition reads back which subjects its last delivered post named,
  // so it can say how each one left the list.
  describe("postedConditionSubjects", () => {
    const KEY = "placeholder_calls_unserved";

    it("answers the subjects the last post named while the condition is firing", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert(KEY, COOLDOWN, "two calls", { subjects: ["bk-1", "bk-2"] });
      expect(await postedConditionSubjects(KEY)).toEqual(["bk-1", "bk-2"]);
    });

    it("answers nothing once the condition has been cleared, so a stale list is never reported again", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert(KEY, COOLDOWN, "two calls", { subjects: ["bk-1", "bk-2"] });
      await resolveAlert(KEY, "all clear");
      expect(await postedConditionSubjects(KEY)).toEqual([]);
    });

    it("answers nothing for a condition that never posted", async () => {
      expect(await postedConditionSubjects(KEY)).toEqual([]);
    });

    it("THROWS when either read fails, never an empty list that reads as nothing listed", async () => {
      slack.postSlack.mockResolvedValue({ ok: true });
      await sendThrottledAlert(KEY, COOLDOWN, "two calls", { subjects: ["bk-1"] });
      failKeyReads.add(firingKey(KEY));
      await expect(postedConditionSubjects(KEY)).rejects.toThrow(/unreadable/);
      failKeyReads.clear();
      failKeyReads.add(KEY);
      await expect(postedConditionSubjects(KEY)).rejects.toThrow(/unreadable/);
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
    clearChannelCache();
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
    clearChannelCache();
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

// #3170: one failure produces exactly one message (Dan, 2026-10-03). Two overlapping
// runs of one lane both read alert_state, both found the page due (or the marker
// set), and both posted. A send is now CLAIMED by a conditional write on the stamp
// the reader saw before anything is posted, so of two concurrent senders exactly one
// can win. Every case here has a control with the condition switched off, proving
// the same two senders DO post twice without it, so a pass is not the fake failing
// to overlap them.
describe("concurrent senders post once (#3170)", () => {
  const COOLDOWN = 30 * 60 * 1000;
  const twoAtOnce = async <T,>(fn: () => Promise<T>): Promise<T[]> => {
    readBarrier.size = 2;
    return Promise.all([fn(), fn()]);
  };

  it("two pages for a key never sent before: one is posted", async () => {
    await twoAtOnce(() => sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"));
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(true);
  });

  it("CONTROL: without the condition the same two senders both post", async () => {
    claims.enforce = false;
    await twoAtOnce(() => sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"));
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
  });

  it("two pages whose cooldown has run out: one is posted", async () => {
    rows.set("lane_failed:sync", new Date(Date.now() - 2 * COOLDOWN).toISOString());
    await twoAtOnce(() => sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"));
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: an expired cooldown without the condition posts twice", async () => {
    claims.enforce = false;
    rows.set("lane_failed:sync", new Date(Date.now() - 2 * COOLDOWN).toISOString());
    await twoAtOnce(() => sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"));
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
  });

  it("a lone sender is never refused by its own claim", async () => {
    // The other direction: a claim that could fail with nobody competing would mute
    // the page, which is worse than the duplicate this exists to stop.
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    rows.set("lane_failed:sync", new Date(Date.now() - 2 * COOLDOWN).toISOString());
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken again");
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
  });

  it("two all-clears for one page: one is posted, and the page is cleared", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    const sent = await twoAtOnce(() => resolveAlert("lane_failed:sync", "recovered"));
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(sent.filter(Boolean)).toHaveLength(1);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(false);
    expect(rows.has("lane_failed:sync")).toBe(false);
  });

  it("CONTROL: without the condition the same two all-clears both post", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    claims.enforce = false;
    await twoAtOnce(() => resolveAlert("lane_failed:sync", "recovered"));
    expect(slack.postSlack).toHaveBeenCalledTimes(2);
  });

  it("an older run cannot clear a page a newer run fired after it looked", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    // Between the older run's read and its claim, a newer run pages again, which
    // re-stamps the firing marker.
    readBarrier.afterRead = () =>
      rows.set(firingKey("lane_failed:sync"), new Date(Date.now() + 1000).toISOString());
    expect(await resolveAlert("lane_failed:sync", "recovered")).toBe(false);
    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(true);
  });

  it("CONTROL: without the condition that older run does clear the newer page", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    claims.enforce = false;
    readBarrier.afterRead = () =>
      rows.set(firingKey("lane_failed:sync"), new Date(Date.now() + 1000).toISOString());
    expect(await resolveAlert("lane_failed:sync", "recovered")).toBe(true);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(false);
  });

  it("a claimed page whose post fails is retried within minutes, not a whole cooldown later (L368)", async () => {
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "ratelimited" });
    const before = Date.now();
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    const nextDue = Date.parse(rows.get("lane_failed:sync") as string) + COOLDOWN;
    expect(nextDue).toBeLessThan(before + 5 * 60_000);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(false);
  });

  it("a claimed page whose post THROWS is still retried within minutes (L368)", async () => {
    // The claim is the only write that landed, so it alone decides how long the page
    // is held off. It is written as the short retry window and only lengthened once
    // the post is delivered.
    slack.postSlack.mockRejectedValueOnce(new Error("socket hang up"));
    const before = Date.now();
    await expect(sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken")).rejects.toThrow();
    const nextDue = Date.parse(rows.get("lane_failed:sync") as string) + COOLDOWN;
    expect(nextDue).toBeLessThan(before + 5 * 60_000);
    expect(nextDue).toBeGreaterThan(before);
  });

  it("a delivered page holds the full cooldown", async () => {
    const before = Date.now();
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    const nextDue = Date.parse(rows.get("lane_failed:sync") as string) + COOLDOWN;
    expect(nextDue).toBeGreaterThanOrEqual(before + COOLDOWN - 1000);
  });

  it("a claimed all-clear whose post throws keeps the page open for the next tick", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(resolveAlert("lane_failed:sync", "recovered")).rejects.toThrow();
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(true);
    expect(await resolveAlert("lane_failed:sync", "recovered")).toBe(true);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(false);
  });

  it("a stamp filter that never matches sends anyway and says so, rather than muting", async () => {
    // Nobody else moved the stamp, so the claim did not lose a race: it could not be
    // made. Failing toward sending keeps the old behaviour (a duplicate at worst).
    claims.casNeverMatches = true;
    rows.set("lane_failed:sync", new Date(Date.now() - 2 * COOLDOWN).toISOString());
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/claim/);

    slack.postSlack.mockClear();
    warn.mockClear();
    const sent = await resolveAlert("lane_failed:sync", "recovered");
    expect(sent).toBe(true);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/claim/);
  });
});

// #3170 review: a row DELETED between the read and the claim is not a lost race. An
// all-clear removes the cooldown row, so a page that read the old stamp just before
// would find its conditional update matching nothing. Nobody posted that page, so it
// must still go out, claimed as an insert.
describe("a row deleted between the read and the claim (#3170)", () => {
  const COOLDOWN = 30 * 60 * 1000;
  const expired = () => new Date(Date.now() - 2 * COOLDOWN).toISOString();

  it("a page whose cooldown row was deleted after the read still posts, once, and is stamped", async () => {
    rows.set("lane_failed:sync", expired());
    readBarrier.afterRead = () => rows.delete("lane_failed:sync");
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(rows.has("lane_failed:sync")).toBe(true);
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(true);
  });

  it("two such pages still post once between them, the insert deciding", async () => {
    rows.set("lane_failed:sync", expired());
    readBarrier.size = 2;
    readBarrier.afterRead = () => rows.delete("lane_failed:sync");
    await Promise.all([
      sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"),
      sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken"),
    ]);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
  });

  it("an all-clear whose marker was deleted after the read stays quiet and does not re-create it", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    readBarrier.afterRead = () => rows.delete(firingKey("lane_failed:sync"));
    expect(await resolveAlert("lane_failed:sync", "recovered")).toBe(false);
    expect(slack.postSlack).not.toHaveBeenCalled();
    expect(rows.has(firingKey("lane_failed:sync"))).toBe(false);
  });
});

// #3170 review: when a claim matches nothing and the re-read that would tell a lost
// race from a filter that cannot match is itself refused, nothing shows a race was
// lost. A broken alert_state costs a duplicate, never silence, so it sends and says so.
describe("an unmatched claim whose re-read fails (#3170)", () => {
  const COOLDOWN = 30 * 60 * 1000;
  afterEach(() => {
    failCooldownRead.value = false;
  });

  it("a page still posts, with a warning", async () => {
    rows.set("lane_failed:sync", new Date(Date.now() - 2 * COOLDOWN).toISOString());
    claims.casNeverMatches = true;
    readBarrier.afterRead = () => {
      failCooldownRead.value = true;
    };
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/claim/);
  });

  it("an all-clear still posts, with a warning", async () => {
    await sendThrottledAlert("lane_failed:sync", COOLDOWN, "broken");
    slack.postSlack.mockClear();
    warn.mockClear();
    claims.casNeverMatches = true;
    readBarrier.afterRead = () => {
      failCooldownRead.value = true;
    };
    expect(await resolveAlert("lane_failed:sync", "recovered")).toBe(true);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/claim/);
  });
});
