import { describe, it, expect, vi, beforeEach } from "vitest";

// #803: a cron invocation killed mid-run (exceededCpu) cannot report its own
// death, so the lanes that never finished are detected by ABSENCE: they stop
// stamping their heartbeat. Roughly 400 invocations were killed before the #760
// fix and nobody noticed for days. This watchdog is the thing that would have
// noticed.
//
// The whole point is monitoring, so its OWN failures must never break a cron
// lane: a watchdog that takes down the sync tick is worse than the silence it
// replaces.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string, _channel?: string) => {}),
  sendThrottledInfo: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  // #1134: every alert_state question this tick has, answered in one read so the
  // every-minute lane does not pay a query per lane.
  existingAlertStateKeys: vi.fn(async (_keys: string[]) => new Set<string>()),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
  firingKey: (key: string) => `alert_firing:${key}`,
}));
const heartbeat = vi.hoisted(() => ({
  readAllHeartbeatMs: vi.fn(async (): Promise<Record<string, number | null>> => ({})),
}));

vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
// The first-sighting marker for never-stamped lanes (#1102), kept in alert_state.
const marker = vi.hoisted(() => ({
  firstSeenAt: null as string | null,
  written: [] as string[],
  cleared: [] as string[],
  throwOn: null as "read" | "write" | "clear" | null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (marker.throwOn === "read") throw new Error("supabase unreachable");
            return { data: marker.firstSeenAt ? { last_sent_at: marker.firstSeenAt } : null };
          },
        }),
      }),
      upsert: async (row: { key: string }) => {
        if (marker.throwOn === "write") throw new Error("supabase unreachable");
        marker.written.push(row.key);
        return { error: null };
      },
      delete: () => ({
        eq: async (_c: string, key: string) => {
          if (marker.throwOn === "clear") throw new Error("supabase unreachable");
          marker.cleared.push(key);
          return { error: null };
        },
      }),
    }),
  }),
}));

import { alertOnStaleLanes } from "./lane-watchdog";

const MIN = 60_000;
const now = () => Date.now();
const ago = (ms: number) => now() - ms;

const healthy = () => ({
  sync: ago(30_000),
  recompute: ago(30_000),
  outbox: ago(30_000),
  selfheal: ago(30_000),
  complete: ago(2 * MIN),
  watch: ago(2 * MIN),
  monitor: ago(2 * MIN),
  "bulk-reassign": ago(2 * MIN),
  // The daily retention lanes (#1102) are judged with neverIsStale ON, so a
  // fixture that omits them reads as "never ran" and alerts. A healthy fleet
  // has them stamped within their 28h bound.
  "prune-routing": ago(4 * 60 * MIN),
  "prune-webhook-payloads": ago(4 * 60 * MIN),
  "prune-bookings-pii": ago(4 * 60 * MIN),
});

beforeEach(() => {
  vi.clearAllMocks();
  marker.firstSeenAt = null;
  marker.written = [];
  marker.cleared = [];
  marker.throwOn = null;
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
  dispatch.existingAlertStateKeys.mockResolvedValue(new Set<string>());
  dispatch.resolveAlert.mockResolvedValue(true);
  heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("alertOnStaleLanes (#803)", () => {
  it("stays silent when every lane is stamping", async () => {
    const stale = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("alerts (Slack only) when the Snowflake mirror export lane goes stale (#1101)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(40 * MIN) });
    const stale = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).toContain("snowflake-export");
    const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:snowflake-export");
    expect(call).toBeTruthy();
    expect(String(call?.[2])).toMatch(/mirror export lane/);
  });

  it("does not alert when the mirror export lane is fresh", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(5 * MIN) });
    const stale = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).not.toContain("snowflake-export");
  });

  // #1123: the two 6h checks ON the mirror were unwatched. Reconcile stamped into a
  // row no bound read; the erasure audit did not stamp at all. Each now has its own
  // bound AND its own message: they sit on a different cron expression and different
  // locks from the export lane, so the old shared copy would have sent a responder
  // to the wrong lane.
  describe("the 6h mirror checks (#1123)", () => {
    it("alerts when the reconcile lane goes quiet, naming its own lock", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "snowflake-export": ago(2 * MIN),
        "snowflake-reconcile": ago(9 * 60 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("snowflake-reconcile");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:snowflake-reconcile",
      );
      const text = String(call?.[2]);
      expect(text).toMatch(/cron_snowflake_reconcile/);
      expect(text).not.toMatch(/cron_snowflake_export/);
      expect(text).toMatch(/app itself is unaffected/);
    });

    it("alerts when the erasure audit goes quiet, saying what stopped being checked", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "erasure-audit": ago(9 * 60 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("erasure-audit");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:erasure-audit",
      );
      const text = String(call?.[2]);
      expect(text).toMatch(/erased/);
      expect(text).toMatch(/cron_erasure_audit/);
      expect(text).not.toMatch(/analytics warehouse is going stale/);
    });

    // The whole failure this issue describes: the audit is broken (not stamping)
    // while its co-scheduled sibling keeps succeeding. That used to be silent.
    it("alerts on a failing audit even while reconcile stays healthy", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "snowflake-reconcile": ago(10 * MIN),
        "erasure-audit": ago(9 * 60 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toEqual(["erasure-audit"]);
    });

    it("stays quiet for a 6h lane that stamped within its 8h bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "snowflake-reconcile": ago(6 * 60 * MIN + 20 * MIN),
        "erasure-audit": ago(6 * 60 * MIN + 20 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale).toEqual([]);
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });
  });

  it("alerts when the bulk-reassign drain goes quiet (#1123)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "bulk-reassign": ago(25 * MIN) });
    const stale = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).toContain("bulk-reassign");
    const call = dispatch.sendThrottledAlert.mock.calls.find(
      (c) => c[0] === "cron_lane_stale:bulk-reassign",
    );
    expect(call).toBeTruthy();
  });

  it("alerts on each lane a CPU kill left unfinished, keyed per lane", async () => {
    // sync ran first and stamped; the later lanes in the same invocation died.
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });

    const stale = await alertOnStaleLanes();

    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);

    const calls = dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][];
    const keys = calls.map((c) => c[0]);
    // Per-lane keys: one dead lane must not throttle away the alert for another.
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => k.includes("recompute") || k.includes("outbox"))).toBe(true);
    // The text has to name the lane and how long it has been quiet, or the alert
    // is not actionable at 3am.
    const texts = calls.map((c) => c[2]).join(" ");
    expect(texts).toContain("recompute");
    expect(texts).toContain("outbox");
  });

  it("does not alert on a lane that has never stamped (fresh deploy, not a death)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: null });
    const stale = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // --- Failure paths. The watchdog runs INSIDE a cron lane, so it must never
  // throw: a monitoring failure must not become a cron failure.
  it("swallows a heartbeat-read failure instead of breaking the calling lane", async () => {
    heartbeat.readAllHeartbeatMs.mockRejectedValueOnce(new Error("db unreachable"));

    const stale = await alertOnStaleLanes();

    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("swallows an alert failure, and still reports the other stale lanes", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack is down"));

    const stale = await alertOnStaleLanes();

    // A failed Slack post must not hide the detection or skip the second lane.
    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
  });

  // #525: the booking-smoke canary is a scheduled GitHub Actions workflow that
  // stamps `smoke-canary` on every successful run. If the schedule silently stops
  // (or starts failing before it can stamp), the safety net is gone and nobody
  // knows. The watchdog detects that by absence too, but with canary-specific copy
  // (it is NOT a cron lane and NOT a CPU kill), and it must never touch the
  // external /api/health signal (covered by the health tests: the canary is not in
  // LANE_STALE_BOUNDS_MS).
  describe("canary staleness (#525)", () => {
    it("alerts when the smoke canary has not stamped within its bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(120 * MIN), // bound is 90m
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
      const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
        string,
        number,
        string,
      ];
      expect(key).toContain("smoke-canary");
      // Canary-specific copy: names the canary and points at the workflow, not a
      // cron CPU kill.
      expect(text).toMatch(/canary/i);
      expect(text).toMatch(/workflow|Actions|schedule/i);
    });

    it("stays silent when the canary stamped recently", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(20 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("does not alert when the canary has never stamped (not yet configured)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": null,
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    // #982: the 6h full book/reschedule/cancel pass stamps its OWN
    // `smoke-canary-full` heartbeat. When it goes stale, the copy must be
    // full-pass-specific and point at re-running the FULL pass, not the generic
    // dry-canary message.
    it("alerts with full-pass-specific copy when smoke-canary-full is stale", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(20 * MIN), // dry tick fine
        "smoke-canary-full": ago(9 * 60 * MIN), // bound is 8h
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("smoke-canary-full");
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
      const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
        string,
        number,
        string,
      ];
      expect(key).toContain("smoke-canary-full");
      // Names the full end-to-end pass and how to recover it (mode=full), so the
      // page is actionable and distinct from the dry-tick alert.
      expect(text).toMatch(/full/i);
      expect(text).toMatch(/reschedule|cancel|end to end/i);
      expect(text).toMatch(/mode.*full|Run workflow|Actions/i);
    });

    it("keys the dry and full canary alerts separately (one can't throttle the other)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(120 * MIN),
        "smoke-canary-full": ago(9 * 60 * MIN),
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane).sort()).toEqual(["smoke-canary", "smoke-canary-full"]);
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
      const keys = (dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][]).map(
        (c) => c[0],
      );
      expect(new Set(keys).size).toBe(2);
    });

    it("reports both a stale cron lane and a stale canary in one tick", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        outbox: ago(25 * MIN),
        "smoke-canary": ago(120 * MIN),
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "smoke-canary"]);
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
    });
  });

  describe("the daily retention lanes (#1102)", () => {
    it("starts a grace window instead of paging the first time a lane is seen missing", async () => {
      // The #1136 regression: deploying the heartbeat code paged all three daily
      // lanes before they had reached their first 03:00 run, claiming they had
      // failed every run. A newly deployed lane must get its bound to appear.
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = null;
      await alertOnStaleLanes();
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
      expect(marker.written).toContain("lane_never_seen:prune-bookings-pii");
    });

    it("stays quiet while a never-stamped lane is still inside its grace window", async () => {
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = new Date(Date.now() - 60 * MIN).toISOString();
      await alertOnStaleLanes();
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("alerts with never-ran copy once the lane has been missing for a full bound", async () => {
      // A lane that genuinely never runs still pages, one bound later than before.
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = new Date(Date.now() - 40 * 60 * MIN).toISOString();
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("prune-bookings-pii");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:prune-bookings-pii",
      );
      expect(call).toBeDefined();
      expect(String(call?.[2])).toMatch(/NEVER completed/);
      expect(String(call?.[2])).not.toMatch(/Infinity|NaN/);
    });

    it("defers rather than false-pages when the sighting marker cannot be read", async () => {
      // A failed read must not become a page. It returns null, which reads as "first
      // sighting", so the worst case is an alert delayed by one bound.
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.throwOn = "read";
      await expect(alertOnStaleLanes()).resolves.toBeDefined();
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("survives a failed sighting write without taking down the watchdog", async () => {
      // This runs inside the every-minute cron lane; a throw here would stop the
      // sync tick, which is worse than a late alert.
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.throwOn = "write";
      await expect(alertOnStaleLanes()).resolves.toBeDefined();
    });

    it("survives a failed sighting clear and still reports the stale lane", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "prune-routing": ago(40 * 60 * MIN),
      });
      marker.throwOn = "clear";
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("prune-routing");
    });

    it("clears a stale sighting once the lane starts stamping again", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "prune-routing": ago(40 * 60 * MIN),
      });
      await alertOnStaleLanes();
      expect(marker.cleared).toContain("lane_never_seen:prune-routing");
    });

    it("alerts with the measured age for a retention lane past its bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "prune-routing": ago(40 * 60 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("prune-routing");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:prune-routing",
      );
      expect(String(call?.[2])).toMatch(/routing decisions/);
    });

    it("stays quiet for retention lanes that completed inside their 28h bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
      expect(await alertOnStaleLanes()).toEqual([]);
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });
  });

  // #1134: a lane coming back to life is the news the person who was paged is
  // waiting for, and until now the only signal was silence, which is
  // indistinguishable from the hourly cooldown still running.
  describe("recovery notices (#1134)", () => {
    const laneKey = (lane: string) => `cron_lane_stale:${lane}`;
    /** What the watchdog actually probes for: the prefixed firing markers. */
    const firingFor = (...lanes: string[]) =>
      new Set(lanes.map((l) => `alert_firing:${laneKey(l)}`));

    it("says a core lane is running again once it stamps inside its bound", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(firingFor("outbox"));
      await alertOnStaleLanes();

      expect(dispatch.resolveAlert).toHaveBeenCalledTimes(1);
      const [key, text] = dispatch.resolveAlert.mock.calls[0];
      expect(key).toBe(laneKey("outbox"));
      expect(text).toContain("outbox");
      expect(text).toMatch(/running again|recovered|is stamping/i);
      // The page told the reader to go and check for a CPU kill and a stuck lock.
      // Repeating that in the all-clear sends them to investigate a fault that is over.
      expect(text).not.toMatch(/exceededCpu/i);
    });

    it("resolves nothing when no lane page is outstanding, at the cost of one read", async () => {
      await alertOnStaleLanes();
      expect(dispatch.existingAlertStateKeys).toHaveBeenCalledTimes(1);
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    it("never resolves a lane that is still stale", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: ago(30 * MIN) });
      dispatch.existingAlertStateKeys.mockResolvedValue(firingFor("outbox"));
      await alertOnStaleLanes();

      expect(dispatch.sendThrottledAlert).toHaveBeenCalled();
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    // THE failure path, and the reason #1149 had to be fixed first. A heartbeat
    // read that failed knows nothing about any lane. Announcing recovery here would
    // tell everyone the fleet is fine on the strength of a query that never ran.
    it("resolves nothing when the heartbeat read fails", async () => {
      heartbeat.readAllHeartbeatMs.mockRejectedValue(new Error("supabase unreachable"));
      dispatch.existingAlertStateKeys.mockResolvedValue(firingFor("outbox"));

      const stale = await alertOnStaleLanes();

      expect(stale).toEqual([]);
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    // A lane absent from the heartbeat table has not recovered; it has never been
    // seen. Recovery requires positive evidence of a recent stamp, not the absence
    // of a staleness verdict.
    it("never resolves a lane that has no heartbeat at all", async () => {
      const { outbox: _dropped, ...withoutOutbox } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(withoutOutbox);
      dispatch.existingAlertStateKeys.mockResolvedValue(firingFor("outbox"));

      await alertOnStaleLanes();

      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    // Each family's page says something different, so each all-clear must too. One
    // generic "recovered" would be the same defect #1123 fixed on the alert side.
    it("gives the canary, the mirror and a retention lane their own all-clear", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(5 * MIN),
        "snowflake-export": ago(5 * MIN),
      });
      dispatch.existingAlertStateKeys.mockResolvedValue(
        firingFor("smoke-canary", "snowflake-export", "prune-routing"),
      );

      await alertOnStaleLanes();

      const byKey = new Map(dispatch.resolveAlert.mock.calls.map(([k, t]) => [k, t]));
      expect(byKey.get(laneKey("smoke-canary"))).toMatch(/booking|canary/i);
      expect(byKey.get(laneKey("snowflake-export"))).toMatch(/warehouse|mirror/i);
      expect(byKey.get(laneKey("prune-routing"))).toMatch(/retention|prune|deleting/i);
      // Every family says plainly that nothing needs doing.
      for (const text of byKey.values()) expect(text).toMatch(/no action/i);
    });

    // A retention lane that never stamped records a "first noticed missing" marker
    // to start its #1102 grace window. That marker was only cleared for a lane that
    // WAS stamping but had fallen behind, so a lane which never stamped and then
    // recovered kept a marker dated to its original sighting. If it later
    // disappeared again, the grace window would already be long expired and it
    // would page instantly instead of waiting out a fresh one.
    it("clears a recovered retention lane's stale first-sighting marker", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["lane_never_seen:prune-routing"]),
      );
      await alertOnStaleLanes();
      expect(marker.cleared).toContain("lane_never_seen:prune-routing");
      // No page was outstanding for it, so it gets no all-clear, only the cleanup.
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    it("does not delete a marker that is not there, so a healthy tick writes nothing", async () => {
      await alertOnStaleLanes();
      expect(marker.cleared).toEqual([]);
    });

    it("does not clear the marker for a retention lane that is still missing", async () => {
      const { "prune-routing": _gone, ...withoutPrune } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(withoutPrune);
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["lane_never_seen:prune-routing"]),
      );
      await alertOnStaleLanes();
      expect(marker.cleared).not.toContain("lane_never_seen:prune-routing");
    });

    it("does not throw when a recovery notice fails to send", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(firingFor("outbox"));
      dispatch.resolveAlert.mockRejectedValue(new Error("slack down"));
      await expect(alertOnStaleLanes()).resolves.toEqual([]);
    });

    it("does not throw when the firing-marker read fails", async () => {
      dispatch.existingAlertStateKeys.mockRejectedValue(new Error("supabase unreachable"));
      await expect(alertOnStaleLanes()).resolves.toEqual([]);
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });
  });
});
