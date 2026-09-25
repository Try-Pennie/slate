import { describe, it, expect, vi, beforeEach } from "vitest";

// #2773: a failed settings read must NEVER resolve to the defaults.
//
// It used to (#571 red-team S4): any error fell through to env and coded defaults
// "so config can never take down alerting". But the defaults are not neutral. Every
// armed switch defaults to OFF, so one failed read of monitor_alert_config quietly
// disarmed the low volume alarm, the failure rate page, the drift page, the roster
// coverage page, the activation and below tier pages and the Regal alerts for that
// tick, dropped the floor overrides and reverted the learned floors, with nothing
// reporting any of it.
//
// So the read THROWS. The monitor lane contains it in a `setup_settings` step whose
// fallback is the LAST KNOWN settings in this isolate, and when there are none the
// checks that depend on a switch or a floor stand down through `monitorSetupGates`
// while the step's own streak pages. Both directions are pinned here: a failure
// never looks like the defaults, and a success is what later failures fall back to.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
const logs = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/log", () => logs);

type Settings = typeof import("./settings");

/** A fresh module per test, so the per isolate last known value starts empty. */
async function freshModule(): Promise<Settings> {
  vi.resetModules();
  return import("./settings");
}

type Result = { error: { message: string } | null; data: unknown };

/** The two reads, each answering with its own result (or throwing). */
function fakeDb(opts: { cooldowns: Result | Error; config: Result | Error }) {
  const settle = (r: Result | Error) => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r));
  return {
    from: (table: string) => ({
      select: () =>
        table === "monitor_settings"
          ? settle(opts.cooldowns)
          : { eq: () => ({ maybeSingle: () => settle(opts.config) }) },
    }),
  };
}

const ARMED_CONFIG = {
  floor_30: 2,
  floor_120: 8,
  volume_ramp_end_on: null,
  volume_learning: null,
  low_volume_armed: true,
  failure_rate_armed: true,
  availability_drift_armed: true,
  roster_coverage_armed: true,
  awaiting_activation_armed: true,
  below_lead_tier_armed: true,
  regal_calls_armed: true,
};
const OK_COOLDOWNS: Result = { error: null, data: [{ key: "availability_data_anomaly", cooldown_min: 10 }] };
const OK_CONFIG: Result = { error: null, data: ARMED_CONFIG };
const REFUSED: Result = { error: { message: "column monitor_alert_config.regal_calls_armed does not exist" }, data: null };

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV };
});

describe("a failed read never resolves to the defaults", () => {
  it("throws when the monitor_alert_config read resolves with an error", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: REFUSED }));
    await expect(m.loadMonitorSettings()).rejects.toThrow(/monitor alert config/);
  });

  it("throws when the cooldown read resolves with an error", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: REFUSED, config: OK_CONFIG }));
    await expect(m.loadMonitorSettings()).rejects.toThrow(/monitor cooldowns/);
  });

  it("throws when the client itself throws", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockImplementation(() => {
      throw new Error("no such table: monitor_settings");
    });
    await expect(m.loadMonitorSettings()).rejects.toThrow(/no such table/);
  });

  it("a cold isolate has no last known settings, so the lane has nothing to fall back on", async () => {
    const m = await freshModule();
    expect(m.lastKnownMonitorSettings()).toBeNull();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: REFUSED }));
    await expect(m.loadMonitorSettings()).rejects.toThrow();
    // A failure is never recorded as a reading.
    expect(m.lastKnownMonitorSettings()).toBeNull();
  });
});

describe("the last known settings are what a later failure falls back to", () => {
  it("keeps the ARMED switches and stored floors of the last good read, not the defaults", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: OK_CONFIG }));
    const good = await m.loadMonitorSettings();
    expect(good.lowVolumeArmed).toBe(true);

    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: REFUSED }));
    await expect(m.loadMonitorSettings()).rejects.toThrow();

    const last = m.lastKnownMonitorSettings();
    expect(last).not.toBeNull();
    // Every switch the failure would have disarmed is still armed.
    expect(last!.lowVolumeArmed).toBe(true);
    expect(last!.failureRateArmed).toBe(true);
    expect(last!.availabilityDriftArmed).toBe(true);
    expect(last!.rosterCoverageArmed).toBe(true);
    expect(last!.awaitingActivationArmed).toBe(true);
    expect(last!.belowLeadTierArmed).toBe(true);
    expect(last!.regalCallsArmed).toBe(true);
    expect(last!.floors.override30).toEqual({ value: 2, origin: "stored" });
    expect(last!.cooldownMs.availability_data_anomaly).toBe(10 * 60_000);
  });

  it("a later good read replaces the last known value", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: OK_CONFIG }));
    await m.loadMonitorSettings();
    admin.supabaseAdmin.mockReturnValue(
      fakeDb({ cooldowns: OK_COOLDOWNS, config: { error: null, data: { ...ARMED_CONFIG, low_volume_armed: false } } }),
    );
    await m.loadMonitorSettings();
    expect(m.lastKnownMonitorSettings()!.lowVolumeArmed).toBe(false);
  });
});

describe("a store that is readable and empty is NOT a failure", () => {
  it("an absent config row resolves through the resolvers (the store is unset, not unreadable)", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(
      fakeDb({ cooldowns: { error: null, data: [] }, config: { error: null, data: null } }),
    );
    const out = await m.loadMonitorSettings();
    expect(out.cooldownMs.low_booking_volume).toBe(m.MONITOR_DEFAULTS.cooldownMs.low_booking_volume);
    expect(out.lowVolumeArmed).toBe(false);
  });

  it("applies stored cooldowns and floors over defaults", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(
      fakeDb({ cooldowns: OK_COOLDOWNS, config: { error: null, data: { floor_30: 2, floor_120: 8 } } }),
    );
    const out = await m.loadMonitorSettings();
    expect(out.cooldownMs.availability_data_anomaly).toBe(10 * 60_000);
    expect(out.floors.override30).toEqual({ value: 2, origin: "stored" });
    expect(out.floors.override120).toEqual({ value: 8, origin: "stored" });
  });
});

// A lane that needs only a COOLDOWN (hydrate-calendars, the schedule parity sweep)
// must not be taken down by a settings blip, and a cooldown cannot disarm anything:
// it only paces an alarm that has already decided to fire. So those callers get the
// last known cooldowns, else the coded ones, and the fallback is logged by name.
describe("loadMonitorCooldowns", () => {
  it("returns the stored cooldowns on a good read", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: OK_CONFIG }));
    const out = await m.loadMonitorCooldowns("test");
    expect(out.availability_data_anomaly).toBe(10 * 60_000);
    expect(logs.log.warn).not.toHaveBeenCalled();
  });

  it("serves the last known cooldowns on a failed read, and says so", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: OK_COOLDOWNS, config: OK_CONFIG }));
    await m.loadMonitorSettings();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: REFUSED, config: REFUSED }));
    const out = await m.loadMonitorCooldowns("test");
    expect(out.availability_data_anomaly).toBe(10 * 60_000);
    expect(logs.log.warn).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ msg: expect.stringMatching(/last known/) }),
      expect.anything(),
    );
  });

  it("falls to the coded cooldowns only with nothing known, and says so", async () => {
    const m = await freshModule();
    admin.supabaseAdmin.mockReturnValue(fakeDb({ cooldowns: REFUSED, config: REFUSED }));
    const out = await m.loadMonitorCooldowns("test");
    expect(out.availability_data_anomaly).toBe(m.MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly);
    expect(logs.log.warn).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ msg: expect.stringMatching(/coded/) }),
      expect.anything(),
    );
  });
});
