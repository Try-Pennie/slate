import { describe, it, expect } from "vitest";
import { ALERT_KEYS, parseMonitorSettingsForm, type MonitorAlertKey } from "./settings";

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
  lowVolumeArmed: "",
  failureRateArmed: "",
  availabilityDriftArmed: "",
  rosterCoverageArmed: "",
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
      // A blank/absent toggle is an explicit disarm (the checkbox is on/off, not tri-state).
      low_volume_armed: false,
      failure_rate_armed: false,
      availability_drift_armed: false,
      roster_coverage_armed: false,
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
});
