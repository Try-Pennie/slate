import { describe, it, expect } from "vitest";
import {
  ALERT_FIELDS,
  ALERT_KEYS,
  MONITOR_DEFAULTS,
  resolveCooldownMs,
  resolveFloors,
  resolveLowVolumeArmed,
  parseMonitorSettingsForm,
  type MonitorSettingsFormInput,
} from "./settings";

// #571: the monitor's cooldowns and low-volume floors become UI-tunable via a
// store, with precedence store > env > coded default. These pure resolvers own
// that precedence + validation; an empty/garbage store must fall through cleanly
// so alerting never breaks. No DB here — the DB read is a thin wrapper elsewhere.

describe("alert keys", () => {
  it("includes the migration-lag page and defaults it to an hourly repeat (#516)", () => {
    expect(ALERT_KEYS).toContain("migration_version_lag");
    // It stays broken until a human applies the migration, and a dormant schema
    // gap has twice gone unnoticed for a whole session, so it keeps asking hourly
    // rather than whispering once.
    expect(MONITOR_DEFAULTS.cooldownMs.migration_version_lag).toBe(60 * 60_000);
    expect(resolveCooldownMs([]).migration_version_lag).toBe(60 * 60_000);
  });

  it("makes the empty-bucket page tunable, at the six-hourly default it already had", () => {
    // Its cooldown used to be a constant inside the availability service, so when a
    // deliberately dark roster (#1272) turned it into sixty messages a wave there
    // was no way to quiet it short of a deploy. Moving it here must not change what
    // it does by default.
    expect(ALERT_KEYS).toContain("empty_buckets");
    expect(MONITOR_DEFAULTS.cooldownMs.empty_buckets).toBe(6 * 60 * 60_000);
    expect(resolveCooldownMs([]).empty_buckets).toBe(6 * 60 * 60_000);
    // And a stored value wins, which is the point of moving it.
    expect(resolveCooldownMs([{ key: "empty_buckets", cooldown_min: 10080 }]).empty_buckets).toBe(
      10080 * 60_000,
    );
  });

  it("gives every alert key an admin field, and every field a real key", () => {
    // A key with no field is a cooldown nobody can tune; a field with no key is a
    // control that silently does nothing. Both have to be impossible.
    expect(ALERT_FIELDS.map((f) => f.key).sort()).toEqual([...ALERT_KEYS].sort());
    for (const f of ALERT_FIELDS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveCooldownMs", () => {
  it("uses the coded default when the store has no row for a key", () => {
    const out = resolveCooldownMs([]);
    expect(out.availability_data_anomaly).toBe(MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly);
    expect(out.availability_booked_solid).toBe(MONITOR_DEFAULTS.cooldownMs.availability_booked_solid);
    expect(out.fallback_covered_availability).toBe(MONITOR_DEFAULTS.cooldownMs.fallback_covered_availability);
    expect(out.low_booking_volume).toBe(MONITOR_DEFAULTS.cooldownMs.low_booking_volume);
    // #569: the thin-tier staffing whisper defaults to a long ~daily cooldown.
    expect(out.thin_tier_staffing).toBe(MONITOR_DEFAULTS.cooldownMs.thin_tier_staffing);
    expect(out.thin_tier_staffing).toBe(24 * 60 * 60_000);
  });

  it("uses a stored cooldown (minutes) converted to ms when set", () => {
    const out = resolveCooldownMs([{ key: "availability_data_anomaly", cooldown_min: 45 }]);
    expect(out.availability_data_anomaly).toBe(45 * 60_000);
  });

  it("#569: the thin-tier staffing cooldown is UI-tunable via the store", () => {
    const out = resolveCooldownMs([{ key: "thin_tier_staffing", cooldown_min: 720 }]);
    expect(out.thin_tier_staffing).toBe(720 * 60_000);
  });

  it("ignores an unset (null) stored value and falls back to default", () => {
    const out = resolveCooldownMs([{ key: "availability_booked_solid", cooldown_min: null }]);
    expect(out.availability_booked_solid).toBe(MONITOR_DEFAULTS.cooldownMs.availability_booked_solid);
  });

  it("ignores invalid stored values (zero, negative, non-integer) and falls back", () => {
    const out = resolveCooldownMs([
      { key: "availability_data_anomaly", cooldown_min: 0 },
      { key: "availability_booked_solid", cooldown_min: -5 },
      { key: "low_booking_volume", cooldown_min: 1.5 },
    ]);
    expect(out.availability_data_anomaly).toBe(MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly);
    expect(out.availability_booked_solid).toBe(MONITOR_DEFAULTS.cooldownMs.availability_booked_solid);
    expect(out.low_booking_volume).toBe(MONITOR_DEFAULTS.cooldownMs.low_booking_volume);
  });

  it("ignores unknown keys", () => {
    const out = resolveCooldownMs([{ key: "totally_unknown", cooldown_min: 99 }]);
    expect(out.availability_data_anomaly).toBe(MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly);
  });
});

describe("resolveFloors", () => {
  it("uses coded defaults when neither store nor env is set", () => {
    const out = resolveFloors(null, {});
    expect(out).toEqual({ floor30: MONITOR_DEFAULTS.floor30, floor120: MONITOR_DEFAULTS.floor120 });
  });

  it("uses env when the store is unset", () => {
    const out = resolveFloors({ floor_30: null, floor_120: null }, { floor30: 7, floor120: 25 });
    expect(out).toEqual({ floor30: 7, floor120: 25 });
  });

  it("prefers the store over env and default (store wins)", () => {
    const out = resolveFloors({ floor_30: 3, floor_120: 12 }, { floor30: 7, floor120: 25 });
    expect(out).toEqual({ floor30: 3, floor120: 12 });
  });

  it("accepts a stored floor of zero (a valid, meaningful floor)", () => {
    const out = resolveFloors({ floor_30: 0, floor_120: 0 }, { floor30: 7, floor120: 25 });
    expect(out).toEqual({ floor30: 0, floor120: 0 });
  });

  it("ignores invalid stored floors (negative, non-integer) and falls through to env/default", () => {
    const out = resolveFloors({ floor_30: -1, floor_120: 2.5 }, { floor30: 7 });
    expect(out).toEqual({ floor30: 7, floor120: MONITOR_DEFAULTS.floor120 });
  });
});

// #575: the low-volume ARMED switch moves into the store, precedence store > env >
// coded default (disarmed), so it can be flipped from the settings UI without a deploy.
describe("resolveLowVolumeArmed", () => {
  it("is DISARMED by default when neither store nor env is set", () => {
    expect(resolveLowVolumeArmed(null, undefined)).toBe(false);
    expect(resolveLowVolumeArmed({ low_volume_armed: null }, undefined)).toBe(false);
  });

  it("uses the env arm flag when the store is unset", () => {
    expect(resolveLowVolumeArmed({ low_volume_armed: null }, true)).toBe(true);
    expect(resolveLowVolumeArmed({ low_volume_armed: null }, false)).toBe(false);
  });

  it("lets the store win over env in BOTH directions (the UI is authoritative once set)", () => {
    expect(resolveLowVolumeArmed({ low_volume_armed: true }, false)).toBe(true);
    expect(resolveLowVolumeArmed({ low_volume_armed: false }, true)).toBe(false);
  });
});

describe("parseMonitorSettingsForm low_volume_armed", () => {
  const base: MonitorSettingsFormInput = {
    cooldownMin: Object.fromEntries(ALERT_KEYS.map((k) => [k, ""])) as Record<
      (typeof ALERT_KEYS)[number],
      string
    >,
    floor30: "",
    floor120: "",
    alertsChannel: "",
    infoChannel: "",
    lowVolumeArmed: "",
  };

  it("parses a checked toggle as armed=true", () => {
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "on" }).config.low_volume_armed).toBe(true);
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "true" }).config.low_volume_armed).toBe(true);
  });

  it("parses an absent/blank toggle as an explicit armed=false (saving disarms)", () => {
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "" }).config.low_volume_armed).toBe(false);
  });
});
