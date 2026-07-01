import { describe, it, expect } from "vitest";
import {
  MONITOR_DEFAULTS,
  resolveCooldownMs,
  resolveFloors,
} from "./settings";

// #571: the monitor's cooldowns and low-volume floors become UI-tunable via a
// store, with precedence store > env > coded default. These pure resolvers own
// that precedence + validation; an empty/garbage store must fall through cleanly
// so alerting never breaks. No DB here — the DB read is a thin wrapper elsewhere.

describe("resolveCooldownMs", () => {
  it("uses the coded default when the store has no row for a key", () => {
    const out = resolveCooldownMs([]);
    expect(out.availability_data_anomaly).toBe(MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly);
    expect(out.availability_booked_solid).toBe(MONITOR_DEFAULTS.cooldownMs.availability_booked_solid);
    expect(out.fallback_covered_availability).toBe(MONITOR_DEFAULTS.cooldownMs.fallback_covered_availability);
    expect(out.low_booking_volume).toBe(MONITOR_DEFAULTS.cooldownMs.low_booking_volume);
  });

  it("uses a stored cooldown (minutes) converted to ms when set", () => {
    const out = resolveCooldownMs([{ key: "availability_data_anomaly", cooldown_min: 45 }]);
    expect(out.availability_data_anomaly).toBe(45 * 60_000);
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
