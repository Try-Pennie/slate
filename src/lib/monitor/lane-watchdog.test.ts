import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
// Cloudflare's status page, read for the combined page (2026-10-26). Replaced so no
// test reaches the network; the reader itself is pinned in scripts/test-cloudflare-status.ts.
const cloudflare = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<{ kind: "incident"; names: string[] } | { kind: "clear" } | { kind: "unknown" }> => ({
    kind: "unknown",
  })),
}));
vi.mock("@/lib/monitor/cloudflare-status", () => ({ readCloudflareCronStatus: cloudflare.read }));
// 2026-10-29: the every minute trigger's delivery, read off lane_runs only when a lane on
// it is quiet. By default a minute tick claimed 30 seconds ago (the trigger is arriving), so
// tests about other causes see the page they always did. The reading itself is pinned in
// scripts/test-minute-lane-backstop.ts.
const claims = vi.hoisted(() => ({
  read: vi.fn(async (_table: unknown, _sinceIso: string) => ({
    rows: ["sync", "recompute", "outbox", "selfheal"].map((lane) => ({
      tick_id: "d0d0d0d0d0d0d0d0",
      lane,
      claimed_at: new Date(Date.now() - 30_000).toISOString(),
    })),
    truncated: false,
  })),
}));
vi.mock("@/lib/monitor/minute-lane-claims", async (orig) => ({
  ...(await orig<typeof import("@/lib/monitor/minute-lane-claims")>()),
  readRecentLaneClaims: claims.read,
}));
// #2875: the "cal.com retired" switch, read through its per isolate cache. Only the
// read is replaced; which lanes belong to cal.com stays the real module's answer.
const retirement = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<boolean | null> => false),
}));
vi.mock("@/lib/calcom/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/calcom/retirement")>()),
  loadCalcomRetiredCached: retirement.load,
}));
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
import { PARKED_VERDICT_DETECTORS } from "./verdict-freshness";

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
  "prune-warehouse-pii": ago(4 * 60 * MIN),
  "prune-regal-calls": ago(4 * 60 * MIN),
  "prune-booking-alert-state": ago(4 * 60 * MIN),
  // The two daily time off lanes (#2543), four stamps and also judged with
  // neverIsStale ON. A healthy fleet has this morning's 7am ET approvals run and
  // this morning's 9am ET nudge in it, both well inside their own bounds, and
  // omitting one would read as a lane that has never run rather than as a gap in
  // the fixture.
  "ooo-approvals": ago(4 * 60 * MIN),
  "ooo-approvals-report": ago(4 * 60 * MIN),
  "ooo-digest": ago(2 * 60 * MIN),
  "ooo-digest-nudge": ago(2 * 60 * MIN),
  // The detector verdict stamps (#1394), also judged with neverIsStale ON: a
  // detector that has NEVER concluded is the exact state they exist to notice, so
  // omitting one from a fixture reads as blind and pages.
  "verdict:low-booking-volume": ago(6 * 60 * MIN),
  "verdict:ooo-protection": ago(10 * MIN),
  // The truth probe stamps here since #1831, because that is now what production
  // looks like: it concludes on essentially every tick, having found buckets
  // offering times after the 2026-09-02 roster flip. While it was parked this
  // fixture omitted it, and leaving it out now would describe a probe that has
  // never concluded and let the healthy tick below pass on its grace window
  // rather than on health.
  "verdict:availability-truth": ago(10 * MIN),
  // #2114: the Twilio half of the hourly roster sync. It concludes on every run
  // that can read Twilio, so a healthy fleet has a stamp inside the hour.
  "verdict:twilio-roster": ago(20 * MIN),
  // #2382: the dead man's switch's own verdict. It concludes on every monitor tick
  // the heartbeat table is readable, so a healthy fleet has a stamp minutes old.
  "verdict:lane-watchdog": ago(5 * MIN),
  // #2505: concludes on every tick the roster and the slot rows are readable.
  "verdict:tier-staffing": ago(5 * MIN),
  // #3381: concludes on every tick that has a served time to judge.
  "verdict:offered-nobody-free": ago(5 * MIN),
  // #3040: concludes on every tick that judges an upcoming booking with an advisor.
  "verdict:buffer-breach": ago(5 * MIN),
  // #2392: the daily proof that the burst counter answers, stamped by a GitHub
  // workflow rather than by this Worker. A healthy fleet has yesterday's run in it,
  // which is well inside the 52h bound that carries it over one dropped run.
  "verdict:burst-counter": ago(24 * 60 * MIN),
  // #2493: the nightly proof that public booking can still be stopped, stamped by a
  // GitHub workflow like the line above and carrying the same 52h bound. A healthy
  // fleet has last night's run in it.
  "verdict:kill-switch": ago(24 * 60 * MIN),
  // #3340: the daily proof that the shared confirm line answers, stamped by the same
  // workflow as the burst counter's and carrying the same 52h bound.
  "verdict:confirm-line": ago(24 * 60 * MIN),
  // #3615: the daily reroute drill, stamped by the same workflow.
  "verdict:reroute-drill": ago(24 * 60 * MIN),
  // #1700: the canary's latency reading, stamped from the 30 minute canary workflow
  // whenever it read a real median, so a healthy fleet has one well inside the hour.
  "verdict:availability-latency": ago(40 * MIN),
  // #2695: Regal has posted every completed call to Slate since 2026-09-24, so a
  // healthy fleet judges one on almost every monitor tick.
  "verdict:regal-calls": ago(10 * MIN),
  // #1941: concludes on every tick the week and the roster are readable,
  // including a fully covered week.
  "verdict:roster-coverage": ago(5 * MIN),
  // #2798: the five gated checks that swallowed a failed read. Each concludes on
  // every monitor tick its read works, so a healthy fleet has a stamp minutes old.
  "verdict:availability-scan": ago(5 * MIN),
  "verdict:calendar-window": ago(5 * MIN),
  "verdict:busy-drift": ago(5 * MIN),
  "verdict:offsite-origin": ago(5 * MIN),
  "verdict:auth-sign-in": ago(5 * MIN),
  "verdict:auth-unexpected-sign-in": ago(5 * MIN),
  "verdict:awaiting-activation": ago(5 * MIN),
  "verdict:stranded-hires": ago(5 * MIN),
  // #3090: the audit chain walk judges every tick the trail reads.
  "verdict:audit-chain": ago(5 * MIN),
  // #3141: the hourly cron CPU check, stamped on every measured day.
  "verdict:cron-budget": ago(40 * MIN),
  "verdict:regal-call-feed": ago(5 * MIN),
  // #2944: the call outcome ratio judges every tick with calls flowing.
  "verdict:regal-call-outcomes": ago(10 * MIN),
  // #2696: armed once the Low pilot put real upcoming bookings in view, and a
  // real roster keeps one in view on every monitor tick.
  "verdict:below-lead-tier": ago(5 * MIN),
  "verdict:cross-system-bookings": ago(30 * MIN),
  // #3027: the daily photo refresh, this morning's run.
  "verdict:advisor-photos": ago(6 * 60 * MIN),
  // #3124: the daily busy minute check, this morning's run.
  "verdict:busy-minutes": ago(6 * 60 * MIN),
  // #1228: noodge's two keyed checks stamp every five minutes, and are judged with
  // neverIsStale ON, so a healthy fleet has both a few minutes old.
  "uptime:api-health": ago(3 * MIN),
  "uptime:availability-canary": ago(3 * MIN),
  // #2513: armed again once real Low leads booked through Slate, and the pilot
  // keeps enough attempts inside its window for a verdict on essentially every
  // tick. It was deliberately absent here while it was parked (#2499).
  "verdict:booking-failure-rate": ago(5 * MIN),
  // #3076: the daily off platform database dump, judged with neverIsStale ON, so a
  // healthy fleet has this morning's upload in it.
  "db-backup": ago(6 * 60 * MIN),
  // #3182: the log shipping receipt arrives on every cron tick Better Stack accepts.
  "log-shipping": ago(1 * MIN),
  // #3460: the recompute lane publishes the pool grouping every minute, judged with
  // neverIsStale ON, so a healthy fleet has a publish a minute old.
  "pool-grouping": ago(1 * MIN),
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
  retirement.load.mockResolvedValue(false);
  cloudflare.read.mockResolvedValue({ kind: "unknown" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("alertOnStaleLanes (#803)", () => {
  it("stays silent when every lane is stamping", async () => {
    const { stale } = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("alerts (Slack only) when the Snowflake mirror export lane goes stale (#1101)", async () => {
    // Past the 90 minute bound (three missed 30 minute runs, #4349).
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(100 * MIN) });
    const { stale } = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).toContain("snowflake-export");
    const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:snowflake-export");
    expect(call).toBeTruthy();
    expect(String(call?.[2])).toMatch(/mirror export lane/);
  });

  it("does not alert when the mirror export lane is fresh", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(5 * MIN) });
    const { stale } = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).not.toContain("snowflake-export");
  });

  it("does not alert on one missed 30 minute export run (#4349)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(60 * MIN) });
    const { stale } = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).not.toContain("snowflake-export");
  });

  // #1561: a detector that CANNOT conclude yet. Before cutover the availability
  // truth probe found no bucket offering times and the failure rate check never
  // saw 20 attempts in an hour, so the blind page fired every 24 hours naming an
  // action nobody could take. Parking is quiet about the blindness, loud about
  // the park, and loud again the moment a parked detector concludes anyway.
  //
  // The shipped registry is empty since #2513 armed the failure rate watch, and the
  // cases below INSTALL their own entry for the duration of the test and remove it
  // after, rather than leaning on whatever the registry holds.
  //
  // That is deliberate rather than convenient. The wiring these prove (the
  // watchdog is quiet about a parked detector's blindness, loud about the park,
  // and loud again the moment it concludes) is exactly what breaks silently the
  // next time somebody parks a detector, and deleting the cases along with the
  // last entry would leave the mechanism shipping untested (L535). The registry
  // is a plain object, so installing an entry is the smallest seam that keeps
  // them real; the pure decision is driven separately in
  // scripts/test-detector-park.ts.
  describe("detectors parked because they cannot conclude yet (#1561)", () => {
    const PARKED = "verdict:booking-failure-rate";
    const laneKey = (lane: string) => `cron_lane_stale:${lane}`;
    const FIXTURE_PARK = {
      reason:
        "a fixture park, installed for this test so these cases do not ride on whichever entry the shipped registry happens to hold",
      issue: 1562,
      unparkWithinMs: 60 * 60_000,
    };
    /**
     * Install the park, run the body, and always put back whatever was there.
     *
     * It RESTORES rather than deletes, which is not a detail: the shipped registry
     * parked this same lane between #2499 and #2513, so deleting the key took the real entry out for
     * every test that ran after one of these, in file order. That turned eleven
     * unrelated cases red and each of them passed alone, which is the shape of a
     * shared mutable fixture rather than of a defect in the thing under test (L205).
     */
    async function withPark(body: () => Promise<void>): Promise<void> {
      const registry = PARKED_VERDICT_DETECTORS as Record<string, unknown>;
      const had = Object.prototype.hasOwnProperty.call(registry, PARKED);
      const previous = registry[PARKED];
      registry[PARKED] = FIXTURE_PARK;
      try {
        await body();
      } finally {
        if (had) registry[PARKED] = previous;
        else delete registry[PARKED];
      }
    }

    it("does not page a parked detector that has never reached a verdict", async () => {
      await withPark(async () => {
        // No stamp at all, and a first sighting old enough that an armed detector
        // would have paged out of its grace window.
        marker.firstSeenAt = new Date(ago(30 * 60 * MIN)).toISOString();
        heartbeat.readAllHeartbeatMs.mockResolvedValue(
          Object.fromEntries(Object.entries(healthy()).filter(([k]) => k !== PARKED)),
        );

        await alertOnStaleLanes();

        expect(
          dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey(PARKED)),
        ).toBeUndefined();
      });
    });

    it("says which detectors are parked instead of going silent about them", async () => {
      await withPark(async () => {
      // No stamp for the parked lane: a FRESH verdict would be the un-park state
      // rather than the parked one, and this case is about the park being visible.
      heartbeat.readAllHeartbeatMs.mockResolvedValue(
        Object.fromEntries(Object.entries(healthy()).filter(([k]) => k !== PARKED)),
      );
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
    });

    // The half that stops the park outliving its reason. Cutover looks exactly
    // like this, and nobody has to remember anything for it to be noticed.
    it("pages to arm a parked detector that has started concluding", async () => {
      await withPark(async () => {
        heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [PARKED]: ago(30 * MIN) });

        await alertOnStaleLanes();

        const call = dispatch.sendThrottledAlert.mock.calls.find(
          (c) => c[0] === `detector_unpark:${PARKED}`,
        );
        expect(call).toBeDefined();
        expect(String(call?.[2])).toMatch(/reached a verdict/i);
        expect(String(call?.[2])).toMatch(/#1562/);
      });
    });

    it("treats an unreadable verdict record as still parked, not as concluding", async () => {
      // #1172: the epoch-0 sentinel is a record that could not be READ. Reading it
      // as a verdict would arm a detector off a corrupt row.
      // Installs the park like its siblings: the shipped registry is empty since
      // #2513, so without it this would judge an ARMED lane and pass vacuously.
      await withPark(async () => {
        heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [PARKED]: 0 });

        await alertOnStaleLanes();

        expect(
          dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `detector_unpark:${PARKED}`),
        ).toBeUndefined();
        // And it really was judged as parked: the park whisper went out, so the
        // absence above is the park's doing rather than the lane being armed.
        expect(
          dispatch.sendThrottledInfo.mock.calls.find((c) => c[0] === "detector_parked"),
        ).toBeDefined();
      });
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

    // #3141: the cron CPU check needs CF_ANALYTICS_TOKEN, which is optional. Unset, it says
    // so on the info channel and cannot conclude, so its verdict lane is not called blind
    // too; set, a token that stops working goes stale and pages like any detector.
    describe("a detector whose optional secret is unset (#3141)", () => {
      const staleCronBudget = () => ({ ...healthy(), "verdict:cron-budget": ago(30 * 60 * MIN) });
      const paged = () =>
        dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey("verdict:cron-budget"));
      afterEach(() => vi.unstubAllEnvs());

      it("does not page the cron CPU verdict lane while CF_ANALYTICS_TOKEN is unset", async () => {
        vi.stubEnv("CF_ANALYTICS_TOKEN", "");
        heartbeat.readAllHeartbeatMs.mockResolvedValue(staleCronBudget());
        await alertOnStaleLanes();
        expect(paged()).toBeUndefined();
      });

      it("pages it once the token is set and it stops concluding", async () => {
        vi.stubEnv("CF_ANALYTICS_TOKEN", "tok");
        heartbeat.readAllHeartbeatMs.mockResolvedValue(staleCronBudget());
        await alertOnStaleLanes();
        expect(paged()).toBeDefined();
      });

      it("excuses nothing else while it is unset", async () => {
        vi.stubEnv("CF_ANALYTICS_TOKEN", "");
        heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...staleCronBudget(), "verdict:ooo-protection": ago(30 * 60 * MIN) });
        await alertOnStaleLanes();
        expect(
          dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === laneKey("verdict:ooo-protection")),
        ).toBeDefined();
      });
    });

    // #1831: the safety net this change actually switches on. While the truth
    // probe was parked, a probe that stopped concluding was silent, and silent is
    // indistinguishable from a probe finding nothing wrong (#1394). Now it pages,
    // and this is the assertion that would have failed before the registry entry
    // came out.
    it("pages the truth probe once it stops concluding, which the park used to hide", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "verdict:availability-truth": ago(30 * 60 * MIN),
      });

      await alertOnStaleLanes();

      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === laneKey("verdict:availability-truth"),
      );
      expect(call).toBeDefined();
      // The blind page, not the un-park page: it says the check is running and has
      // stopped answering, and it must not read as a fault in the lane itself.
      expect(String(call?.[2])).toMatch(/not reached a verdict/i);
    });

    // #2695: the Regal calls detector is watched now that Regal posts to Slate. A
    // feed that stops arriving (the webhook switched off in Regal, the key rotated)
    // leaves the detector with nothing to judge, which is silent on its own; this
    // is the page that notices. Both directions: past its four day bound it pages
    // as blind, and inside it the healthy fixture above stays silent.
    it("pages the Regal calls detector once it stops concluding (#2695)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "verdict:regal-calls": ago(5 * 24 * 60 * MIN),
      });

      const { stale } = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("verdict:regal-calls");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === laneKey("verdict:regal-calls"),
      );
      expect(call).toBeDefined();
      expect(String(call?.[2])).toMatch(/not reached a verdict/i);
    });

    it("stays silent on a Regal calls verdict inside its bound (#2695)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "verdict:regal-calls": ago(3 * 24 * 60 * MIN),
      });

      const { stale } = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).not.toContain("verdict:regal-calls");
    });

    // The production consequence of merging #1831, in one assertion. The un-park
    // page has been firing daily since 2026-09-03; removing the registry entry is
    // what ends it, with the ending that says somebody armed the detector rather
    // than the one that says the verdict lapsed (L11).
    it("all-clears the truth probe's standing un-park page as armed, not lapsed", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["alert_firing:detector_unpark:verdict:availability-truth"]),
      );

      await alertOnStaleLanes();

      const call = dispatch.resolveAlert.mock.calls.find(
        (c) => c[0] === "detector_unpark:verdict:availability-truth",
      );
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/armed again/i);
      expect(String(call?.[1])).not.toMatch(/stays parked/i);
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
      const { stale } = await alertOnStaleLanes();
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
      const { stale } = await alertOnStaleLanes();
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
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toEqual(["erasure-audit"]);
    });

    it("stays quiet for a 6h lane that stamped within its 8h bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "snowflake-reconcile": ago(6 * 60 * MIN + 20 * MIN),
        "erasure-audit": ago(6 * 60 * MIN + 20 * MIN),
      });
      const { stale } = await alertOnStaleLanes();
      expect(stale).toEqual([]);
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });
  });

  it("alerts when the bulk-reassign drain goes quiet (#1123)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "bulk-reassign": ago(25 * MIN) });
    const { stale } = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).toContain("bulk-reassign");
    const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lanes_stale");
    expect(call?.[2]).toContain("bulk-reassign");
  });

  // 2026-10-26: Cloudflare stopped firing the every minute cron and five lanes went quiet
  // in the same second. They posted five identical pages (six with the pool grouping),
  // which Dan called "too much". One cause is one page, naming every lane in it.
  it("pages ONCE for every core lane that went quiet, naming them all", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });

    const { stale } = await alertOnStaleLanes();

    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text, opts] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
      { subjects: string[] },
    ];
    expect(key).toBe("cron_lanes_stale");
    expect(text).toContain("recompute");
    expect(text).toContain("outbox");
    // The lanes are the page's subjects, so a THIRD lane going quiet is a change that
    // posts at once rather than waiting out a day's repeat (#3801).
    expect([...opts.subjects].sort()).toEqual(["outbox", "recompute"]);
  });

  it("says the lanes stopped together and quotes Cloudflare's incident when there is one", async () => {
    const stoppedAt = ago(16 * MIN);
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      sync: stoppedAt,
      recompute: stoppedAt,
      outbox: stoppedAt,
      selfheal: stoppedAt,
      "reroute-hold-sweep": stoppedAt,
    });
    cloudflare.read.mockResolvedValueOnce({ kind: "incident", names: ["Delayed, missed, and duplicated Workers Cron Triggers"] });

    await alertOnStaleLanes();

    const text = dispatch.sendThrottledAlert.mock.calls[0][2];
    expect(text).toMatch(/^5 cron lanes have not run for 16 minutes/);
    expect(text).toContain("They stopped together while other lanes kept running");
    expect(text).toContain(`"Delayed, missed, and duplicated Workers Cron Triggers"`);
  });

  // 2026-10-29, 4:52 to 5:06 AM ET: Cloudflare delivered no every minute tick while every
  // other schedule fired. lane_runs proves it, so the page says it rather than guessing.
  it("says Cloudflare delivered no every-minute tick since the last one lane_runs holds", async () => {
    const stoppedAt = ago(16 * MIN);
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      sync: stoppedAt,
      recompute: stoppedAt,
      outbox: stoppedAt,
      selfheal: stoppedAt,
      "reroute-hold-sweep": stoppedAt,
    });
    const lastTick = Date.parse("2026-10-29T08:51:57Z");
    claims.read.mockResolvedValueOnce({
      rows: [
        ...["sync", "recompute", "outbox", "selfheal"].map((lane) => ({ tick_id: "a1a1a1a1a1a1a1a1", lane, claimed_at: new Date(lastTick).toISOString() })),
        // A five minute tick's own lane: never a delivery of the minute trigger.
        { tick_id: "b2b2b2b2b2b2b2b2", lane: "monitor", claimed_at: new Date(ago(MIN)).toISOString() },
      ],
      truncated: false,
    });

    await alertOnStaleLanes();

    const text = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lanes_stale")?.[2];
    expect(text).toContain("Cloudflare has delivered no every-minute tick since 4:51am ET.");
    expect(text).not.toContain("a schedule or deploy problem");
    expect(text).toContain("Advisors' calendars aren't syncing, so offered times may be out of date.");
  });

  it("keeps the schedule or deploy sentence, and still pages, when lane_runs cannot be read", async () => {
    const stoppedAt = ago(16 * MIN);
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), sync: stoppedAt, recompute: stoppedAt, outbox: stoppedAt, selfheal: stoppedAt });
    claims.read.mockRejectedValueOnce(new Error("lane_runs read failed: timeout"));

    await alertOnStaleLanes();

    const text = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lanes_stale")?.[2];
    expect(text).toContain("They stopped together while other lanes kept running: a schedule or deploy problem");
    expect(text).not.toContain("every-minute tick");
  });

  it("reads lane_runs only when a lane on the every minute trigger is quiet", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "bulk-reassign": ago(25 * MIN) });
    await alertOnStaleLanes();
    expect(claims.read).not.toHaveBeenCalled();
    heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
    await alertOnStaleLanes();
    expect(claims.read).not.toHaveBeenCalled();
  });

  it("reads Cloudflare's status page only when a core lane is quiet", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
    await alertOnStaleLanes();
    expect(cloudflare.read).not.toHaveBeenCalled();
  });

  it("names a stopped pool grouping on the lanes' page when recompute is among them", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(16 * MIN),
      "pool-grouping": ago(16 * MIN),
    });
    await alertOnStaleLanes();
    const lanesPage = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lanes_stale");
    expect(lanesPage?.[2]).toContain("The pool grouping, which the recompute lane publishes, has stopped with it.");
  });

  // Review of 33522ff: the pool grouping's own page waits on this one (ALERT_FOLDS), so if
  // it stopped AFTER this page posted and nothing marked that as new, nobody would hear of
  // it until the daily repeat. It is a subject, so its joining is a change that posts at once.
  it("names a stopped pool grouping as a subject, so it joining the page posts at once", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(16 * MIN),
      "pool-grouping": ago(16 * MIN),
    });
    await alertOnStaleLanes();
    const lanesPage = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lanes_stale") as unknown as
      | [string, number, string, { subjects: string[] }]
      | undefined;
    expect(lanesPage?.[3].subjects).toEqual(["recompute", "pool-grouping"]);
  });

  it("clears the lanes' page once every core lane is stamping again", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
    dispatch.existingAlertStateKeys.mockResolvedValueOnce(new Set(["alert_firing:cron_lanes_stale"]));

    await alertOnStaleLanes();

    expect(dispatch.resolveAlert).toHaveBeenCalledWith("cron_lanes_stale", expect.stringContaining("running again"));
  });

  it("does not clear the lanes' page while any core lane is still quiet", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: ago(25 * MIN) });
    dispatch.existingAlertStateKeys.mockResolvedValue(new Set(["alert_firing:cron_lanes_stale"]));

    await alertOnStaleLanes();

    expect(dispatch.resolveAlert).not.toHaveBeenCalledWith("cron_lanes_stale", expect.anything());
  });

  it("does not alert on a lane that has never stamped (fresh deploy, not a death)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: null });
    const { stale } = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // --- Failure paths. The watchdog runs INSIDE a cron lane, so it must never
  // throw: a monitoring failure must not become a cron failure.
  it("swallows a heartbeat-read failure instead of breaking the calling lane", async () => {
    heartbeat.readAllHeartbeatMs.mockRejectedValueOnce(new Error("db unreachable"));

    const { stale } = await alertOnStaleLanes();

    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #2382: swallowing it is right, and saying nothing about having swallowed it was
  // not. An empty stale list is exactly what a healthy fleet returns, so the caller
  // could not tell "every lane is stamping" from "nothing was looked at" (L215), and
  // the monitor lane stamped `verdict:lane-watchdog` either way.
  it("reports judged:false when the heartbeat read fails, and judged:true when it did not", async () => {
    heartbeat.readAllHeartbeatMs.mockRejectedValueOnce(new Error("db unreachable"));
    await expect(alertOnStaleLanes()).resolves.toEqual({ judged: false, stale: [] });

    await expect(alertOnStaleLanes()).resolves.toEqual({ judged: true, stale: [] });
  });

  it("swallows an alert failure, and still reports every stale lane", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack is down"));

    const { stale } = await alertOnStaleLanes();

    // A failed Slack post must not hide the detection or throw into the calling lane.
    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
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

      const { stale } = await alertOnStaleLanes();

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
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("does not alert when the canary has never stamped (not yet configured)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": null,
      });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    // #982: the full book/reschedule/cancel pass (hourly since #1493) stamps its OWN
    // `smoke-canary-full` heartbeat. When it goes stale, the copy must be
    // full-pass-specific and point at re-running the FULL pass, not the generic
    // dry-canary message.
    it("alerts with full-pass-specific copy when smoke-canary-full is stale", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(20 * MIN), // dry tick fine
        "smoke-canary-full": ago(4 * 60 * MIN), // bound is 3h
      });

      const { stale } = await alertOnStaleLanes();

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
      // #1493: the schedule it names is the one that runs now.
      expect(text).toMatch(/hourly scheduled run/);
      expect(text).not.toMatch(/6h/);
    });

    it("keys the dry and full canary alerts separately (one can't throttle the other)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(120 * MIN),
        "smoke-canary-full": ago(9 * 60 * MIN),
      });

      const { stale } = await alertOnStaleLanes();

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

      const { stale } = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "smoke-canary"]);
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
    });
  });

  // #2543: before this, neither daily time off lane appeared in any bounds map, so
  // a lane that stopped firing was watched by nothing at all and the only record of
  // a morning that produced nothing was a 200 nobody reads.
  describe("the two daily time off lanes (#2543)", () => {
    const quiet = (lane: string, ageMs: number) => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), [lane]: ago(ageMs) });
      // Past its grace window, so a never-stamped lane is not what is under test.
      marker.firstSeenAt = new Date(Date.now() - 200 * 60 * MIN).toISOString();
    };
    const pageFor = (lane: string) =>
      dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `cron_lane_stale:${lane}`);

    it("pages when the approvals report has not gone out, and says what that costs", async () => {
      quiet("ooo-approvals-report", 40 * 60 * MIN);
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("ooo-approvals-report");
      const call = pageFor("ooo-approvals-report");
      expect(call).toBeDefined();
      // The consequence, not the mechanism: this is read on a phone by somebody who
      // does not know the lane exists.
      expect(String(call?.[2])).toMatch(/sales managers/i);
      expect(String(call?.[2])).not.toMatch(/Infinity|NaN|undefined/);
    });

    it("says something different when the cron itself stopped, because the remedy differs", async () => {
      quiet("ooo-approvals", 40 * 60 * MIN);
      await alertOnStaleLanes();
      const cron = String(pageFor("ooo-approvals")?.[2]);
      quiet("ooo-approvals-report", 40 * 60 * MIN);
      dispatch.sendThrottledAlert.mockClear();
      await alertOnStaleLanes();
      const report = String(pageFor("ooo-approvals-report")?.[2]);
      expect(cron).not.toEqual(report);
      // One sends the reader at the schedule, the other at the route's own failure.
      expect(cron).toMatch(/cron-routes|wrangler/);
      expect(report).toMatch(/500|Gmail/);
    });

    it("does not page the weekday nudge over a weekend, which is its longest legitimate silence", async () => {
      // Friday afternoon to Monday morning is about three days. A bound reasoned
      // from "daily plus slack" would page every Sunday for ever (L36).
      quiet("ooo-digest-nudge", 70 * 60 * MIN);
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("ooo-digest-nudge");
      expect(pageFor("ooo-digest-nudge")).toBeUndefined();
    });

    it("does page the nudge once it has been quiet longer than a weekend", async () => {
      quiet("ooo-digest-nudge", 5 * 24 * 60 * MIN);
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("ooo-digest-nudge");
      expect(String(pageFor("ooo-digest-nudge")?.[2])).toMatch(/manager/i);
    });

    it("gives a never-stamped time off lane its grace window rather than paging on the deploy", async () => {
      // These stamps do not exist until this change ships, so without the grace
      // window every one of them would page the moment it deployed, which is the
      // #1136 regression one family along.
      const { "ooo-digest-nudge": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = null;
      await alertOnStaleLanes();
      expect(pageFor("ooo-digest-nudge")).toBeUndefined();
      expect(marker.written).toContain("lane_never_seen:ooo-digest-nudge");
    });

    it("all-clears a time off lane that is running again", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["alert_firing:cron_lane_stale:ooo-approvals-report"]),
      );
      await alertOnStaleLanes();
      const call = dispatch.resolveAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:ooo-approvals-report",
      );
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/No action is needed/);
    });
  });

  // #3076: the daily dump to R2 is the only copy of the non booking tables that
  // lives outside Supabase, so a dump that stopped is a backup that stopped.
  describe("the daily off platform database dump (#3076)", () => {
    const pageFor = (lane: string) =>
      dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `cron_lane_stale:${lane}`);

    it("does not page a dump that is a few hours late, inside the 26 hour bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "db-backup": ago(25 * 60 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("db-backup");
      expect(pageFor("db-backup")).toBeUndefined();
    });

    it("pages once the newest dump is older than 26 hours, and says what is unprotected", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "db-backup": ago(27 * 60 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("db-backup");
      const text = String(pageFor("db-backup")?.[2]);
      expect(text).toMatch(/backup/i);
      expect(text).toMatch(/advisors|working hours|time off/i);
      expect(text).toMatch(/db-backup/);
      expect(text).not.toMatch(/Infinity|NaN|undefined/);
      // Slack only: a missing backup is not the site being down. No channel is named,
      // only the lane as the page's one subject (#3801).
      expect(pageFor("db-backup")?.[3]).toEqual({ subjects: ["db-backup"] });
    });

    it("re-pages once a day, not hourly, since only the next daily run can clear it (#3801)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "db-backup": ago(27 * 60 * MIN) });
      await alertOnStaleLanes();
      // Nothing a reader does inside an hour could clear it before tomorrow's dump
      // (L36), and #3801 made a day the repeat for every unchanged condition.
      expect(pageFor("db-backup")?.[1]).toBe(24 * 60 * MIN);
    });

    it("gives a dump that has never run its grace window, then pages that no backup exists", async () => {
      const { "db-backup": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      await alertOnStaleLanes();
      expect(pageFor("db-backup")).toBeUndefined();
      expect(marker.written).toContain("lane_never_seen:db-backup");

      // A whole bound later it has still never stamped: that is a database with no
      // off platform copy at all, which must not stay silent for ever.
      dispatch.sendThrottledAlert.mockClear();
      marker.firstSeenAt = new Date(Date.now() - 27 * 60 * MIN).toISOString();
      await alertOnStaleLanes();
      expect(String(pageFor("db-backup")?.[2])).toMatch(/never/i);
    });

    it("all-clears once a dump lands again", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set(["alert_firing:cron_lane_stale:db-backup"]));
      await alertOnStaleLanes();
      const call = dispatch.resolveAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:db-backup");
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/No action is needed/);
    });
  });

  // #3182: a revoked token, a Better Stack outage or a tail worker that is not
  // running all end the receipts the same way, and none of them may look like a
  // quiet day.
  describe("log shipping to Better Stack (#3182)", () => {
    const pageFor = (lane: string) =>
      dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `cron_lane_stale:${lane}`);

    it("does not page inside the 15 minute bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "log-shipping": ago(14 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("log-shipping");
      expect(pageFor("log-shipping")).toBeUndefined();
    });

    it("pages once no receipt has arrived for 15 minutes, Slack only, saying where the cause is", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "log-shipping": ago(20 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("log-shipping");
      const page = pageFor("log-shipping");
      expect(String(page?.[2])).toMatch(/Better Stack/);
      expect(String(page?.[2])).toMatch(/wrangler tail slate-log-tail/);
      // #3801: once a day while unchanged.
      expect(page?.[1]).toBe(24 * 60 * MIN);
      // Slack only: log history stopping is not the site being down.
      expect(page?.[3]).toEqual({ subjects: ["log-shipping"] });
    });

    it("gives a tail worker that has never sent a receipt its grace window, then pages never", async () => {
      const { "log-shipping": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      await alertOnStaleLanes();
      expect(pageFor("log-shipping")).toBeUndefined();
      expect(marker.written).toContain("lane_never_seen:log-shipping");

      dispatch.sendThrottledAlert.mockClear();
      marker.firstSeenAt = new Date(Date.now() - 20 * MIN).toISOString();
      await alertOnStaleLanes();
      expect(String(pageFor("log-shipping")?.[2])).toMatch(/never/i);
    });

    it("all-clears only once a receipt arrives inside the bound", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set(["alert_firing:cron_lane_stale:log-shipping"]));
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "log-shipping": ago(20 * MIN) });
      await alertOnStaleLanes();
      expect(dispatch.resolveAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:log-shipping")).toBeUndefined();

      heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
      await alertOnStaleLanes();
      const call = dispatch.resolveAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:log-shipping");
      expect(String(call?.[1])).toMatch(/reaching Better Stack again/);
    });

    it("clears nothing when the heartbeats could not be read", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set(["alert_firing:cron_lane_stale:log-shipping"]));
      heartbeat.readAllHeartbeatMs.mockRejectedValue(new Error("supabase unreachable"));
      await alertOnStaleLanes();
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });
  });

  // #3460: the recompute lane publishes the pool grouping every minute. A publisher that
  // stopped leaves every cold server keying its confirm line by code, which is how
  // confirms keyed before #3460, so nothing else would ever say so.
  describe("the pool grouping publish (#3460)", () => {
    const pageFor = (lane: string) =>
      dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `cron_lane_stale:${lane}`);

    it("does not page inside the 10 minute bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "pool-grouping": ago(9 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("pool-grouping");
      expect(pageFor("pool-grouping")).toBeUndefined();
    });

    it("pages, Slack only, once nothing has been published for 10 minutes, naming the stake and where to look", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "pool-grouping": ago(25 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("pool-grouping");
      const page = pageFor("pool-grouping");
      expect(String(page?.[2])).toMatch(/pool grouping has not been published/);
      expect(String(page?.[2])).toMatch(/tag=pool-grouping/);
      expect(String(page?.[2])).toMatch(/Bookings still go through/);
      // #3801: once a day while unchanged, and the lane as its one subject.
      expect(page?.[1]).toBe(24 * 60 * MIN);
      expect(page?.[3]).toEqual({ subjects: ["pool-grouping"] });
    });

    it("gives a publish that has never landed its grace window, then pages never", async () => {
      const { "pool-grouping": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      await alertOnStaleLanes();
      expect(pageFor("pool-grouping")).toBeUndefined();
      expect(marker.written).toContain("lane_never_seen:pool-grouping");

      dispatch.sendThrottledAlert.mockClear();
      marker.firstSeenAt = new Date(Date.now() - 20 * MIN).toISOString();
      await alertOnStaleLanes();
      expect(String(pageFor("pool-grouping")?.[2])).toMatch(/NEVER once been published/);
    });

    it("all-clears only once a publish lands inside the bound", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(new Set(["alert_firing:cron_lane_stale:pool-grouping"]));
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "pool-grouping": ago(25 * MIN) });
      await alertOnStaleLanes();
      expect(dispatch.resolveAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:pool-grouping")).toBeUndefined();

      heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
      await alertOnStaleLanes();
      const call = dispatch.resolveAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:pool-grouping");
      expect(String(call?.[1])).toMatch(/being published again/);
    });
  });

  describe("the external uptime checks' heartbeats (#1228)", () => {
    const pageFor = (lane: string) =>
      dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === `cron_lane_stale:${lane}`);

    it("pages when noodge's /api/health check has stopped reaching Slate, and says what to do", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "uptime:api-health": ago(45 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("uptime:api-health");
      const text = String(pageFor("uptime:api-health")?.[2]);
      // What to DO, not the mechanism: the check is registered and enabled, and
      // noodge itself is running.
      expect(text).toMatch(/noodge/);
      expect(text).toMatch(/registered/);
      expect(text).toMatch(/enabled/);
      expect(text).toMatch(/running/);
      expect(text).toMatch(/\/api\/health\b/);
      // The row as noodge's dashboard names it (production id 5), so the reader
      // can find it; monitors/slate.sql in Try-Pennie/noodge keeps that name.
      expect(text).toContain('"Slate: API health (DB + cron lanes)"');
      expect(text).not.toMatch(/Infinity|NaN|undefined/);
    });

    it("names the availability check separately, so one page cannot stand for both", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "uptime:availability-canary": ago(45 * MIN),
      });
      await alertOnStaleLanes();
      expect(pageFor("uptime:api-health")).toBeUndefined();
      const text = String(pageFor("uptime:availability-canary")?.[2]);
      expect(text).toMatch(/\/api\/health\/availability/);
      expect(text).toContain('"Slate: Booker availability canary"');
    });

    it("stays quiet inside the bound, through a run noodge is still retrying", async () => {
      // Two quiet runs is a transport blip noodge has not yet alerted on itself.
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "uptime:api-health": ago(11 * MIN) });
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("uptime:api-health");
      expect(pageFor("uptime:api-health")).toBeUndefined();
    });

    it("gives a never-stamped check its grace window rather than paging on the deploy", async () => {
      const { "uptime:api-health": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = null;
      await alertOnStaleLanes();
      expect(pageFor("uptime:api-health")).toBeUndefined();
      expect(marker.written).toContain("lane_never_seen:uptime:api-health");
    });

    it("pages a check that has never stamped once its grace window is spent, naming the missing key", async () => {
      // A deployment with no UPTIME_HEARTBEAT_KEY never stamps at all, so this is
      // the page it gets, and it has to say so.
      const { "uptime:api-health": _omitted, ...rest } = healthy();
      heartbeat.readAllHeartbeatMs.mockResolvedValue(rest);
      marker.firstSeenAt = new Date(Date.now() - 60 * MIN).toISOString();
      await alertOnStaleLanes();
      const text = String(pageFor("uptime:api-health")?.[2]);
      expect(text).toMatch(/never/i);
      expect(text).toMatch(/UPTIME_HEARTBEAT_KEY/);
      expect(text).toMatch(/monitors:sync:slate/);
    });

    it("all-clears a check that is reaching Slate again", async () => {
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["alert_firing:cron_lane_stale:uptime:availability-canary"]),
      );
      await alertOnStaleLanes();
      const call = dispatch.resolveAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:uptime:availability-canary",
      );
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/noodge/i);
      expect(String(call?.[1])).toMatch(/No action is needed/);
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
      const { stale } = await alertOnStaleLanes();
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
      const { stale } = await alertOnStaleLanes();
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
      const { stale } = await alertOnStaleLanes();
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
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toContain("prune-routing");
      const call = dispatch.sendThrottledAlert.mock.calls.find(
        (c) => c[0] === "cron_lane_stale:prune-routing",
      );
      expect(String(call?.[2])).toMatch(/routing decisions/);
    });

    it("stays quiet for retention lanes that completed inside their 28h bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
      expect(await alertOnStaleLanes()).toEqual({ judged: true, stale: [] });
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
      const { stale } = await alertOnStaleLanes();

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
      // Since #4168 that is the runbook section, which holds the lane's lock and fields.
      expect(text).toContain("outbox");
      expect(text).toContain("A lane or schedule has gone quiet");
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

      const { stale } = await alertOnStaleLanes();

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

      const { stale } = await alertOnStaleLanes();

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
      // The page names the likely causes and sends the reader to the runbook (an
      // earlier page named a CPU kill and a stuck lock). Repeating any of that in the
      // all-clear sends them to investigate a fault that is over.
      expect(text).not.toMatch(/exceededCpu/i);
      expect(text).not.toMatch(/runbook|deploy cancelled|far from the database/i);
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

      const { stale } = await alertOnStaleLanes();

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
      await expect(alertOnStaleLanes()).resolves.toEqual({ judged: true, stale: [] });
    });

    it("does not throw when the firing-marker read fails", async () => {
      dispatch.existingAlertStateKeys.mockRejectedValue(new Error("supabase unreachable"));
      await expect(alertOnStaleLanes()).resolves.toEqual({ judged: true, stale: [] });
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });
  });

  // #2875: once cal.com is marked retired, the two comparison lanes stop stamping
  // by construction (there is nothing to compare against), and paging "comparison
  // went quiet" every cooldown would be the watchdog reporting the cutover as a
  // fault. Live, and a setting that could not be read, keep today's page.
  describe("the cal.com retired switch (#2875)", () => {
    const quietCalcomLanes = () => ({
      ...healthy(),
      "schedule-parity": ago(40 * 60 * MIN), // bound is 30h
      "router-replay": ago(12 * 24 * 60 * MIN), // bound is 9 days
    });
    const sentKeys = () => dispatch.sendThrottledAlert.mock.calls.map((c) => c[0] as string);

    it("pages both quiet cal.com lanes while cal.com is live, as today", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue(quietCalcomLanes());
      const { stale } = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).toEqual(expect.arrayContaining(["schedule-parity", "router-replay"]));
      expect(sentKeys()).toEqual(
        expect.arrayContaining(["cron_lane_stale:schedule-parity", "cron_lane_stale:router-replay"]),
      );
    });

    it("pages nothing about either lane once cal.com is retired", async () => {
      retirement.load.mockResolvedValue(true);
      heartbeat.readAllHeartbeatMs.mockResolvedValue(quietCalcomLanes());
      const { stale, judged } = await alertOnStaleLanes();
      expect(judged).toBe(true);
      expect(stale.map((l) => l.lane)).not.toContain("schedule-parity");
      expect(stale.map((l) => l.lane)).not.toContain("router-replay");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("still pages the booking canary once cal.com is retired", async () => {
      retirement.load.mockResolvedValue(true);
      heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...quietCalcomLanes(), "smoke-canary": ago(120 * MIN) });
      await alertOnStaleLanes();
      expect(sentKeys()).toEqual(["cron_lane_stale:smoke-canary"]);
    });

    it("keeps paging when the setting could not be read, so a failed read never silences a live lane", async () => {
      retirement.load.mockResolvedValue(null);
      heartbeat.readAllHeartbeatMs.mockResolvedValue(quietCalcomLanes());
      await alertOnStaleLanes();
      expect(sentKeys()).toEqual(
        expect.arrayContaining(["cron_lane_stale:schedule-parity", "cron_lane_stale:router-replay"]),
      );
    });

    it("keeps paging when the retirement read throws", async () => {
      retirement.load.mockRejectedValue(new Error("supabase unreachable"));
      heartbeat.readAllHeartbeatMs.mockResolvedValue(quietCalcomLanes());
      const { judged } = await alertOnStaleLanes();
      expect(judged).toBe(true);
      expect(sentKeys()).toContain("cron_lane_stale:schedule-parity");
    });

    it("ends a page already open on a cal.com lane, saying cal.com was retired rather than that it recovered", async () => {
      retirement.load.mockResolvedValue(true);
      heartbeat.readAllHeartbeatMs.mockResolvedValue(quietCalcomLanes());
      dispatch.existingAlertStateKeys.mockResolvedValue(
        new Set(["alert_firing:cron_lane_stale:schedule-parity"]),
      );
      await alertOnStaleLanes();
      const resolved = dispatch.resolveAlert.mock.calls.filter((c) => c[0] === "cron_lane_stale:schedule-parity");
      expect(resolved).toHaveLength(1);
      expect(resolved[0][1]).toMatch(/retired/i);
      expect(resolved[0][1]).not.toMatch(/running again/i);
      // A lane whose page never fired sends nothing.
      expect(dispatch.resolveAlert.mock.calls.map((c) => c[0])).not.toContain("cron_lane_stale:router-replay");
    });
  });
});
