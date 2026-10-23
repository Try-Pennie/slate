import { describe, it, expect } from "vitest";
import {
  ALERT_KEYS,
  codedPoolNearlyFullShare,
  parseMonitorSettingsForm,
  resolvePoolNearlyFullShare,
  resolveTierRecovery,
  type MonitorAlertKey,
} from "./settings";

// #571 red-team S1: a blank field must revert to fallback by storing an explicit
// NULL, never the number 0 (a blanked floor of 0 would permanently mute the
// low-volume alert). Invalid values are rejected with an error, not silently
// coerced. This pure parser owns that; the server action just calls it.

// Derived from ALERT_KEYS rather than listed by hand, so adding an alert key
// (#516 added migration_version_lag) does not break every fixture below.
const blank = {
  cooldownMin: Object.fromEntries(ALERT_KEYS.map((k) => [k, ""])) as Record<
    MonitorAlertKey,
    string
  >,
  floor30: "",
  floor120: "",
  alertsChannel: "",
  infoChannel: "",
  handoffChannel: "",
  lowVolumeArmed: "",
  failureRateArmed: "",
  availabilityDriftArmed: "",
  rosterCoverageArmed: "",
  awaitingActivationArmed: "",
  belowLeadTierArmed: "",
  regalCallsArmed: "",
  ownerReassignNoticeOn: "",
  tierRecoveryMinTimes: "",
  tierRecoveryHoldMin: "",
  poolNearlyFullOpenPct: "",
};

describe("parseMonitorSettingsForm", () => {
  it("maps every blank field to explicit null (revert to fallback), no errors", () => {
    const out = parseMonitorSettingsForm(blank);
    expect(out.errors).toEqual([]);
    expect(out.cooldowns.every((c) => c.cooldown_min === null)).toBe(true);
    expect(out.config).toEqual({
      floor_30: null,
      floor_120: null,
      alerts_channel: null,
      info_channel: null,
      handoff_channel: null,
      // A blank/absent toggle is an explicit disarm (the checkbox is on/off, not tri-state).
      low_volume_armed: false,
      failure_rate_armed: false,
      availability_drift_armed: false,
      roster_coverage_armed: false,
      awaiting_activation_armed: false,
      below_lead_tier_armed: false,
      regal_calls_armed: false,
      owner_reassign_notice_on: false,
      empty_tier_recovery_min_times: null,
      empty_tier_recovery_hold_min: null,
      pool_nearly_full_open_pct: null,
    });
  });

  it("does NOT coerce a blank floor to 0", () => {
    const out = parseMonitorSettingsForm(blank);
    expect(out.config.floor_30).toBeNull();
    expect(out.config.floor_120).toBeNull();
  });

  it("parses valid cooldown minutes and floors", () => {
    const out = parseMonitorSettingsForm({
      ...blank,
      cooldownMin: { ...blank.cooldownMin, availability_data_anomaly: "45" },
      floor30: "3",
      floor120: "0",
    });
    expect(out.errors).toEqual([]);
    const anomaly = out.cooldowns.find((c) => c.key === "availability_data_anomaly");
    expect(anomaly?.cooldown_min).toBe(45);
    expect(out.config.floor_30).toBe(3);
    expect(out.config.floor_120).toBe(0);
  });

  // #2367: the handoff channel is its own field with no fallback, so a blank one is
  // stored as null (unset) and never borrows the alerts channel.
  it("trims the handoff channel and stores null for blank", () => {
    const set = parseMonitorSettingsForm({ ...blank, alertsChannel: "#alerts", handoffChannel: "  C-SALES " });
    expect(set.config.handoff_channel).toBe("C-SALES");
    const unset = parseMonitorSettingsForm({ ...blank, alertsChannel: "#alerts", handoffChannel: "   " });
    expect(unset.config.handoff_channel).toBeNull();
  });

  // The owner reassign notice switch: checked posts the notice, unchecked or absent
  // stores false, so a save always writes the admin's decision rather than a null.
  it("stores the owner reassign notice switch as a definite on or off", () => {
    expect(parseMonitorSettingsForm({ ...blank, ownerReassignNoticeOn: "on" }).config.owner_reassign_notice_on).toBe(true);
    expect(parseMonitorSettingsForm({ ...blank, ownerReassignNoticeOn: "" }).config.owner_reassign_notice_on).toBe(false);
  });

  // #3766 (lesson L769): the notice posts ONLY to the handoff channel, which has no
  // fallback. Switched on with that channel blank, every notice is withheld, the save
  // still reads as saved, and the first sign is a weekly count. So the save refuses
  // the pair, naming the field that fixes it, at the moment the switch goes on.
  it("refuses turning the owner reassign notice on with no handoff channel", () => {
    const out = parseMonitorSettingsForm({ ...blank, ownerReassignNoticeOn: "on", handoffChannel: "   " });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/handoff channel/i);
  });

  it("accepts the owner reassign notice on when a handoff channel is set", () => {
    const out = parseMonitorSettingsForm({ ...blank, ownerReassignNoticeOn: "on", handoffChannel: "C-SALES" });
    expect(out.errors).toEqual([]);
    expect(out.config.owner_reassign_notice_on).toBe(true);
  });

  it("leaves a blank handoff channel alone while the notice is off", () => {
    expect(parseMonitorSettingsForm({ ...blank, handoffChannel: "" }).errors).toEqual([]);
  });

  it("trims channels and stores null for blank", () => {
    const out = parseMonitorSettingsForm({ ...blank, alertsChannel: "  #alerts  ", infoChannel: "" });
    expect(out.config.alerts_channel).toBe("#alerts");
    expect(out.config.info_channel).toBeNull();
  });

  it("rejects a non-positive or non-integer cooldown with an error", () => {
    const out = parseMonitorSettingsForm({
      ...blank,
      cooldownMin: { ...blank.cooldownMin, availability_data_anomaly: "0", low_booking_volume: "1.5" },
    });
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("rejects a negative floor with an error", () => {
    const out = parseMonitorSettingsForm({ ...blank, floor30: "-1" });
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("rejects an absurdly large cooldown (out of bounds)", () => {
    const out = parseMonitorSettingsForm({
      ...blank,
      cooldownMin: { ...blank.cooldownMin, availability_booked_solid: "999999" },
    });
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("arms each switch independently, so saving the form cannot arm another one", () => {
    const onlyRate = parseMonitorSettingsForm({ ...blank, failureRateArmed: "on" });
    expect(onlyRate.config.failure_rate_armed).toBe(true);
    expect(onlyRate.config.low_volume_armed).toBe(false);
    expect(onlyRate.config.availability_drift_armed).toBe(false);

    const onlyVolume = parseMonitorSettingsForm({ ...blank, lowVolumeArmed: "on" });
    expect(onlyVolume.config.low_volume_armed).toBe(true);
    expect(onlyVolume.config.failure_rate_armed).toBe(false);
    expect(onlyVolume.config.availability_drift_armed).toBe(false);

    const onlyDrift = parseMonitorSettingsForm({ ...blank, availabilityDriftArmed: "on" });
    expect(onlyDrift.config.availability_drift_armed).toBe(true);
    expect(onlyDrift.config.low_volume_armed).toBe(false);
    expect(onlyDrift.config.failure_rate_armed).toBe(false);
  });

  // #3227: how many open times a paged tier needs, and for how long, before its
  // all clear goes out. Outside the range is refused rather than coerced, and a
  // zero minute hold is a real choice (clear on the first good tick).
  it("stores the tier recovery settings and refuses them outside their range", () => {
    const ok = parseMonitorSettingsForm({ ...blank, tierRecoveryMinTimes: "5", tierRecoveryHoldMin: "0" });
    expect(ok.errors).toEqual([]);
    expect(ok.config.empty_tier_recovery_min_times).toBe(5);
    expect(ok.config.empty_tier_recovery_hold_min).toBe(0);
    for (const bad of ["0", "51", "2.5", "three"]) {
      const out = parseMonitorSettingsForm({ ...blank, tierRecoveryMinTimes: bad });
      expect(out.errors.length, `open times ${bad}`).toBeGreaterThan(0);
      expect(out.config.empty_tier_recovery_min_times).toBeNull();
    }
    for (const bad of ["-1", "241", "1.5"]) {
      const out = parseMonitorSettingsForm({ ...blank, tierRecoveryHoldMin: bad });
      expect(out.errors.length, `hold ${bad}`).toBeGreaterThan(0);
      expect(out.config.empty_tier_recovery_hold_min).toBeNull();
    }
  });

  // #3559: the nearly full pool line, a whole percentage. Blank is the coded 10%,
  // and a value the notice could never or would always fire at is refused.
  it("stores the nearly full pool line and refuses it outside its range", () => {
    const ok = parseMonitorSettingsForm({ ...blank, poolNearlyFullOpenPct: "20" });
    expect(ok.errors).toEqual([]);
    expect(ok.config.pool_nearly_full_open_pct).toBe(20);
    for (const bad of ["0", "51", "12.5", "ten"]) {
      const out = parseMonitorSettingsForm({ ...blank, poolNearlyFullOpenPct: bad });
      expect(out.errors.length, `line ${bad}`).toBeGreaterThan(0);
      expect(out.config.pool_nearly_full_open_pct).toBeNull();
    }
  });

  it("resolves the nearly full pool line as a share, falling back to 10%", () => {
    expect(codedPoolNearlyFullShare()).toBe(0.1);
    expect(resolvePoolNearlyFullShare(null)).toBe(0.1);
    expect(resolvePoolNearlyFullShare({ pool_nearly_full_open_pct: null })).toBe(0.1);
    expect(resolvePoolNearlyFullShare({ pool_nearly_full_open_pct: 25 })).toBe(0.25);
    // A stored value outside the range the form accepts is not trusted.
    expect(resolvePoolNearlyFullShare({ pool_nearly_full_open_pct: 90 })).toBe(0.1);
  });

  it("resolves the tier recovery settings, falling back to 3 times and 30 minutes", () => {
    expect(resolveTierRecovery(null)).toEqual({ minOpenTimes: 3, holdMs: 30 * 60_000 });
    expect(
      resolveTierRecovery({ empty_tier_recovery_min_times: 6, empty_tier_recovery_hold_min: 0 }),
    ).toEqual({ minOpenTimes: 6, holdMs: 0 });
    // A stored value outside the range the form accepts is not trusted.
    expect(
      resolveTierRecovery({ empty_tier_recovery_min_times: 0, empty_tier_recovery_hold_min: 9999 }),
    ).toEqual({ minOpenTimes: 3, holdMs: 30 * 60_000 });
  });
});
