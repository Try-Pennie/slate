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
  "prune-busy-blocks": ago(4 * 60 * MIN),
  // The detector verdict stamps (#1394), also judged with neverIsStale ON: a
  // detector that has NEVER concluded is the exact state they exist to notice, so
  // omitting one from a fixture reads as blind and pages.
  "verdict:low-booking-volume": ago(6 * 60 * MIN),
  "verdict:ooo-protection": ago(10 * MIN),
  // The two PARKED detectors (#1561) are deliberately absent, because that is
  // what production looks like: neither has ever reached a verdict, and while
  // they are parked that is a known, accepted gap rather than a page. Stamping
  // them here would describe a fleet where the park is over, which is its own
  // alert and has its own tests below.
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

  // #1561: a detector that CANNOT conclude yet. Before cutover the availability
  // truth probe finds no bucket offering times and the failure rate check never
  // sees 20 attempts in an hour, so the blind page fired every 24 hours naming an
  // action nobody could take. Parking is quiet about the blindness, loud about
  // the park, and loud again the moment a parked detector concludes anyway.
  describe("detectors parked because they cannot conclude yet (#1561)", () => {
    const PARKED = "verdict:availability-truth";
    const laneKey = (lane: string) => `cron_lane_stale:${lane}`;

    it("does not page a parked detector that has never reached a verdict", async () => {
      // The exact production state: no stamp at all, and a first sighting old
      // enough that an armed detector would have paged out of its grace window.
      marker.firstSeenAt = new Date(ago(30 * 60 * MIN)).toISOString();

      await alertOnStaleLanes();

      expect(
        dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(PARKED)),
      ).toBeUndefined();
    });

    it("says which detectors are parked instead of going silent about them", async () => {
      await alertOnStaleLanes();

      const call = dispatch.sendThrottledInfo.mock.calls.find((c) => c[0] === "detector_parked");
      expect(call).toBeDefined();
      // The whisper has to carry what is not being watched and how the park ends,
      // or it is the #1394 blindness one level up: a safety net off, and silence.
      expect(String(call?.[2])).toMatch(/parked/i);
      expect(String(call?.[2])).toMatch(/#1562/);
      // Slow enough that it is never the thing anyone scrolls past.
      expect(call?.[1]).toBeGreaterThanOrEqual(7 * 24 * 60 * MIN);
    });

    // The half that stops the park outliving its reason. Cutover looks exactly
    // like this, and nobody has to remember anything for it to be noticed.
    it("pages to arm a parked detector that has started concluding", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [PARKED]: ago(30 * MIN) });

      await alertOnStaleLanes();

      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === `detector_unpark:${PARKED}`,
      );
      expect(call).toBeDefined();
      expect(String(call?.[2])).toMatch(/reached a verdict/i);
      expect(String(call?.[2])).toMatch(/#1562/);
    });

    it("treats an unreadable verdict record as still parked, not as concluding", async () => {
      // #1172: the epoch-0 sentinel is a record that could not be READ. Reading it
      // as a verdict would arm a detector off a corrupt row.
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [PARKED]: 0 });

      await alertOnStaleLanes();

      expect(
        dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `detector_unpark:${PARKED}`),
      ).toBeUndefined();
    });

    it("all-clears the un-park page once the detector is armed", async () => {
      // "Armed" means the registry entry is gone, so the lane is no longer parked;
      // ooo-protection stands in for that state here.
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["alert_firing:detector_unpark:verdict:ooo-protection"]),
      );

      await alertOnStaleLanes();

      const call = dispatch.resolveAlert.mock.calls.find(
        (c) => c[0] === "detector_unpark:verdict:ooo-protection",
      );
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/armed again/i);
    });

    // The park must silence exactly what it names and nothing else, or it becomes
    // a way to switch off the whole family by accident.
    it("still pages an armed detector that has gone blind", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "verdict:ooo-protection": ago(30 * 60 * MIN),
      });

      await alertOnStaleLanes();

      expect(
        dispatch.sendThrottledAlert.mock.calls.find(
          (c) => c[0] === laneKey("verdict:ooo-protection"),
        ),
      ).toBeDefined();
    });
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

    it("pages rather than waits forever when the sighting marker is unparseable (#1169)", async () => {
      // A corrupt first-seen stamp used to parse to NaN, so "has a full bound
      // elapsed since first sighting?" compared false on every tick and the lane
      // could never page. Unreadable must land on the paged side: the sighting is
      // treated as ancient, not as pending.
      const { "prune-bookings-pii": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = "not-a-timestamp";
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("prune-bookings-pii");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:prune-bookings-pii",
      );
      expect(call).toBeDefined();
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
  // #1172: a corrupt stored stamp reads as epoch 0 so the lane fails closed and
  // pages, which is right. What the page must NOT do is render the arithmetic
  // that follows: "has not run for 29,800,000 minutes" reads as a broken alert
  // rather than a broken lane, and it buries the one fact worth having at 3am.
  describe("a lane whose stored stamp cannot be read", () => {
    // The epoch-0 sentinel the heartbeat readers store for an unparseable stamp.
    const UNREADABLE = 0;

    it("still pages (fails closed) rather than passing as healthy", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: UNREADABLE });
      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("outbox");
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    });

    it("says the last-run record is unreadable instead of quoting an absurd age", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: UNREADABLE });
      await alertOnStaleLanes();

      const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
      expect(text).toMatch(/cannot be read/i);
      // No five-plus digit minute count anywhere in the copy.
      expect(text).not.toMatch(/\d{5,}\s*minutes/);
      // It still names the lane and points somewhere useful.
      expect(text).toContain("outbox");
      expect(text).toContain("cron_outbox");
    });

    it("a genuinely quiet lane still gets its real, measured age", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: ago(25 * MIN) });
      await alertOnStaleLanes();

      const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
      expect(text).toMatch(/has not run for 25 minutes/);
      expect(text).not.toMatch(/cannot be read/i);
    });

    it("says it for the canary and the mirror lanes too, not just the core lanes", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": UNREADABLE,
        "snowflake-export": UNREADABLE,
      });
      await alertOnStaleLanes();

      const texts = dispatch.sendThrottledAlert.mock.calls.map((c) => c[2] as string);
      expect(texts).toHaveLength(2);
      for (const text of texts) {
        expect(text).toMatch(/cannot be read/i);
        expect(text).not.toMatch(/\d{5,}\s*minutes/);
      }
    });
  });

  // #1394: a detector that keeps RUNNING while concluding nothing. The lane
  // heartbeats above cannot see this by construction, because the lane really did
  // run; the availability truth probe passed every one of them for its whole life
  // while never once comparing a real calendar (#1377).
  describe("detectors that have stopped reaching a verdict (#1394)", () => {
    const laneKey = (lane: string) => `cron_lane_stale:${lane}`;
    // An ARMED detector: the parked two (#1561) are deliberately not paged for
    // blindness, so testing that path through one of them would assert nothing.
    const ARMED = "verdict:ooo-protection";

    it("pages when a detector has not concluded for longer than its own bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [ARMED]: ago(30 * 60 * MIN) });
      marker.firstSeenAt = null;

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain(ARMED);
      const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(ARMED));
      expect(call).toBeDefined();
      expect(String(call?.[2])).toMatch(/verdict/i);
      // The distinction the whole feature rests on: this lane is NOT quiet, so the
      // copy must not send anyone after a CPU kill or a stuck lock.
      expect(String(call?.[2])).not.toMatch(/exceededCpu|cron_verdict/i);
    });

    it("stays silent while every detector concluded inside its bound", async () => {
      await alertOnStaleLanes();
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    // THE case the issue is named after. A probe deployed months ago that has
    // produced a real verdict zero times has no stamp at all, so the default
    // leniency for a never-stamped lane would make this feature structurally
    // unable to see the one state it exists for.
    it("pages a detector that has NEVER once concluded, after its grace window", async () => {
      const { [ARMED]: _never, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = new Date(ago(30 * 60 * MIN)).toISOString();

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain(ARMED);
      const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(ARMED));
      expect(String(call?.[2])).toMatch(/NEVER/);
      expect(String(call?.[2])).not.toMatch(/Infinity|NaN/);
    });

    it("gives a freshly deployed detector its grace window instead of paging on deploy", async () => {
      const { [ARMED]: _never, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = null;

      await alertOnStaleLanes();

      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
      expect(marker.written).toContain(`lane_never_seen:${ARMED}`);
    });

    it("re-pages a blind detector daily rather than hourly", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [ARMED]: ago(30 * 60 * MIN) });
      await alertOnStaleLanes();
      const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(ARMED));
      // A detector stays blind until somebody changes something, and before cutover
      // that can legitimately be days. An hourly re-page trains people to ignore it.
      expect(call?.[1]).toBeGreaterThanOrEqual(24 * 60 * MIN);
    });

    it("says the record is unreadable rather than quoting an age it never measured", async () => {
      // #1169 / #1172: an unparseable stamp reads as epoch 0, which is stale (fail
      // closed) but whose "age" is 56 years of arithmetic, not a measurement.
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [ARMED]: 0 });
      await alertOnStaleLanes();
      const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(ARMED));
      expect(String(call?.[2])).toMatch(/cannot be read/i);
      expect(String(call?.[2])).not.toMatch(/\d{4,}\s*days/);
    });

    it("all-clears a detector that is concluding again, in its own words", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set([`alert_firing:${laneKey(ARMED)}`]));

      await alertOnStaleLanes();

      const call = dispatch.resolveAlert.mock.calls.find((c) => c[0] === laneKey(ARMED));
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/verdict again|measuring/i);
      expect(String(call?.[1])).toMatch(/no action/i);
    });

    // L98 / #1134: a tick that could not read the heartbeats measured nothing, so
    // it must not announce that a detector started concluding again.
    it("all-clears nothing when the heartbeat read failed", async () => {
      heartbeat.readAllHeartbeatMs.mockRejectedValue(new Error("supabase unreachable"));
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set([`alert_firing:${laneKey(ARMED)}`]));

      await alertOnStaleLanes();

      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });
  });

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
