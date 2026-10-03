import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveChannels, defaultAlertsChannel, clearChannelCache } from "./channels";

// #571: the Slack destination becomes UI-tunable and applies to ALL alerts.
// Precedence store > env > default; the info channel falls back to the resolved
// alerts channel so a quiet signal is never silently lost. This pure resolver
// owns the fallback chain (the cached DB read is a thin wrapper elsewhere). Note
// it reads the RAW env channels separately, NOT the collapsed slackInfoChannel().

describe("resolveChannels", () => {
  it("uses raw env channels when the store is unset", () => {
    const out = resolveChannels(null, { alertsEnv: "#alerts", infoEnv: "#quiet" });
    expect(out).toEqual({ alerts: "#alerts", info: "#quiet" });
  });

  it("prefers the stored channels over env (store wins)", () => {
    const out = resolveChannels(
      { alerts_channel: "#store-alerts", info_channel: "#store-quiet" },
      { alertsEnv: "#alerts", infoEnv: "#quiet" },
    );
    expect(out).toEqual({ alerts: "#store-alerts", info: "#store-quiet" });
  });

  it("treats an empty stored channel as unset and falls through to env", () => {
    const out = resolveChannels(
      { alerts_channel: "", info_channel: "" },
      { alertsEnv: "#alerts", infoEnv: "#quiet" },
    );
    expect(out).toEqual({ alerts: "#alerts", info: "#quiet" });
  });

  it("falls the info channel back to the RESOLVED alerts channel when info is unset everywhere", () => {
    const out = resolveChannels(
      { alerts_channel: "#store-alerts", info_channel: null },
      { alertsEnv: "#env-alerts", infoEnv: "" },
    );
    // info unset in store and env -> uses the resolved alerts channel (store wins there)
    expect(out).toEqual({ alerts: "#store-alerts", info: "#store-alerts" });
  });

  it("is all-empty when nothing is configured anywhere", () => {
    const out = resolveChannels(null, { alertsEnv: "", infoEnv: "" });
    expect(out).toEqual({ alerts: "", info: "" });
  });
});

// #3121: the cached DB read around the resolver. A FAILED read used to be cached
// for a minute exactly like a good one, with no log line, so a store-set channel
// was silently replaced by the env channel and nothing said so.
const db = vi.hoisted(() => ({
  reply: { data: null as unknown, error: null as unknown },
  throws: null as Error | null,
  reads: 0,
}));
const logged = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            db.reads++;
            if (db.throws) throw db.throws;
            return db.reply;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/log", () => logged);

describe("defaultAlertsChannel (#3121)", () => {
  beforeEach(() => {
    clearChannelCache();
    vi.clearAllMocks();
    db.reads = 0;
    db.throws = null;
    db.reply = { data: { alerts_channel: "#store", info_channel: null }, error: null };
    vi.stubEnv("SLACK_ALERTS_CHANNEL", "#env");
    vi.stubEnv("SLACK_INFO_CHANNEL", "");
  });

  it("caches a successful read", async () => {
    expect(await defaultAlertsChannel()).toBe("#store");
    expect(await defaultAlertsChannel()).toBe("#store");
    expect(db.reads).toBe(1);
  });

  it("falls back to env on a read error, says so, and does NOT cache the fallback", async () => {
    db.reply = { data: null, error: { message: "permission denied" } };
    expect(await defaultAlertsChannel()).toBe("#env");
    expect(logged.log.warn).toHaveBeenCalledTimes(1);
    // The next post reads again, so the store's channel is back the moment it is readable.
    db.reply = { data: { alerts_channel: "#store", info_channel: null }, error: null };
    expect(await defaultAlertsChannel()).toBe("#store");
    expect(db.reads).toBe(2);
  });

  it("falls back to env on a thrown read, says so, and does NOT cache the fallback", async () => {
    const thrown = new Error("fetch failed");
    db.throws = thrown;
    expect(await defaultAlertsChannel()).toBe("#env");
    expect(logged.log.warn).toHaveBeenCalledTimes(1);
    expect(logged.log.warn.mock.calls[0]![2]).toBe(thrown);
    db.throws = null;
    expect(await defaultAlertsChannel()).toBe("#store");
  });

  it("caches an EMPTY store (no row) as the real answer it is", async () => {
    db.reply = { data: null, error: null };
    expect(await defaultAlertsChannel()).toBe("#env");
    expect(await defaultAlertsChannel()).toBe("#env");
    expect(db.reads).toBe(1);
    expect(logged.log.warn).not.toHaveBeenCalled();
  });

  it("re-reads after the save action clears the cache", async () => {
    await defaultAlertsChannel();
    clearChannelCache();
    db.reply = { data: { alerts_channel: "#new", info_channel: null }, error: null };
    expect(await defaultAlertsChannel()).toBe("#new");
  });
});
