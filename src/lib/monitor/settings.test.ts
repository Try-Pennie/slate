import { describe, it, expect } from "vitest";
import {
  ALERT_FIELDS,
  ALERT_URGENCY_ORDER,
  ALERT_KEYS,
  MONITOR_DEFAULTS,
  resolveCooldownMs,
  resolveFloors,
  resolveLowVolumeArmed,
  resolveFailureRateArmed,
  resolveBelowLeadTierArmed,
  parseMonitorSettingsForm,
  type MonitorSettingsFormInput,
} from "./settings";
import { ALERT_CATALOG } from "@/lib/notify/alert-catalog";
import { floorsFor } from "./volume-floors";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline";

// #571: the monitor's cooldowns and low-volume floors become UI-tunable via a
// store, with precedence store > env > coded default. These pure resolvers own
// that precedence + validation; an empty/garbage store must fall through cleanly
// so alerting never breaks. No DB here — the DB read is a thin wrapper elsewhere.

describe("alert keys", () => {
  it("resolves a real cooldown for every alert that has a default (2026-09-24)", () => {
    // `catchall_rate` had a default here and no place in ALERT_KEYS, so the
    // resolver never visited it and its cooldown came back undefined. The page
    // then repeated every tick. Enumerated from the DEFAULTS, not from
    // ALERT_KEYS, because ALERT_KEYS is the list that was wrong.
    const resolved = resolveCooldownMs([]);
    for (const [key, ms] of Object.entries(MONITOR_DEFAULTS.cooldownMs)) {
      expect(resolved[key as keyof typeof resolved], key).toBe(ms);
      expect(Number.isFinite(ms) && ms > 0, key).toBe(true);
    }
    // #3801: a condition repeats once a day while unchanged.
    expect(resolved.catchall_rate).toBe(24 * 60 * 60_000);
  });

  it("offers every alert key on the settings screen", () => {
    expect(ALERT_FIELDS.map((f) => f.key)).toContain("catchall_rate");
  });

  it("includes the migration-lag page and defaults it to the daily condition repeat (#516, #3801)", () => {
    expect(ALERT_KEYS).toContain("migration_version_lag");
    // It stays broken until a human applies the migration, so it keeps asking while
    // it lasts: once a day while unchanged since #3801 (it was hourly), and at once
    // when it changes. A stored cooldown can make it hourly again.
    expect(MONITOR_DEFAULTS.cooldownMs.migration_version_lag).toBe(24 * 60 * 60_000);
    expect(resolveCooldownMs([]).migration_version_lag).toBe(24 * 60 * 60_000);
  });

  it("makes the empty-bucket page tunable, at the urgent hourly repeat (#3801)", () => {
    // Its cooldown used to be a constant inside the availability service, so when a
    // deliberately dark roster (#1272) turned it into sixty messages a wave there
    // was no way to quiet it short of a deploy. A tier offering leads no time is one
    // of the urgent conditions (Dan, 2026-10-16), so it repeats hourly while it lasts.
    expect(ALERT_KEYS).toContain("empty_tier");
    expect(MONITOR_DEFAULTS.cooldownMs.empty_tier).toBe(60 * 60_000);
    expect(resolveCooldownMs([]).empty_tier).toBe(60 * 60_000);
    // And a stored value wins, which is the point of moving it.
    expect(resolveCooldownMs([{ key: "empty_tier", cooldown_min: 10080 }]).empty_tier).toBe(
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

  // #1955: Dan on the cooldowns section, "I hate everything about this. we can
  // do so much better than this design." One of the six faults was that it gave
  // no sense of which of these matter, while every sentence said so in a word
  // somebody had to parse row by row. That is the organising axis, so it is a
  // recorded fact now rather than something read out of the prose (L192).
  it("records how loud each alert is, rather than leaving it in the sentence", () => {
    for (const f of ALERT_FIELDS) {
      expect(ALERT_URGENCY_ORDER, `${f.key} has a real urgency`).toContain(f.urgency);
    }
    // Every level is USED. A level nothing carries is a group heading that can
    // never appear, and one that carries everything is not an axis at all.
    for (const level of ALERT_URGENCY_ORDER) {
      expect(
        ALERT_FIELDS.filter((f) => f.urgency === level).length,
        `${level} has at least one alert`,
      ).toBeGreaterThan(0);
    }
    expect(ALERT_FIELDS.every((f) => f.urgency === ALERT_FIELDS[0].urgency)).toBe(false);
  });

  // Cross checked against the alert CATALOG, which independently records which
  // keys are mere whispers on the info channel. So this is not a snapshot of a
  // judgement: it is the one direction the two sources genuinely constrain each
  // other in.
  //
  // ONLY that direction. `info` means "never needed action", so an info key
  // classified here as a page or an alert is a real contradiction. The reverse
  // does NOT hold: `condition` is about whether an alert can CLEAR, not about
  // how loud it is, and `availability_booked_solid` is deliberately a condition
  // (it stops being true) and deliberately quiet (agents being full is not a
  // fault, #570). Asserting that direction too would fail on a correct
  // classification.
  it("never calls a whisper on the info channel a page", () => {
    const kind = new Map(ALERT_CATALOG.map((e) => [e.key, e.kind]));
    const contradictions = ALERT_FIELDS.filter(
      (f) => kind.get(f.key) === "info" && (f.urgency === "page" || f.urgency === "alert"),
    ).map((f) => `${f.key} is catalog info and grouped as ${f.urgency}`);
    expect(contradictions).toEqual([]);
    // The check is only real if the catalog actually calls some of these info.
    const infoKeys = ALERT_FIELDS.filter((f) => kind.get(f.key) === "info");
    expect(infoKeys.length, "some of these keys are info in the catalog").toBeGreaterThan(0);
  });

  // The section's group heading carries the urgency now, so the sentence must
  // not restate it: that was the issue's "the hint carries two jobs", and 23
  // sentences each opening with their own volume is the wall of text Dan had
  // stripped from another page for the same reason (L579).
  //
  // Checked as a CONTRADICTION rather than as a vocabulary match: a field
  // grouped as a whisper whose sentence calls itself a page is the drift worth
  // catching, and demanding each sentence contain its own level's exact word
  // would just be a synonym list (it already failed on "Quiet nudge", which is a
  // notice by any reading).
  it("leaves the volume to the group heading rather than restating it", () => {
    for (const f of ALERT_FIELDS) {
      const help = f.help.toLowerCase();
      for (const other of ALERT_URGENCY_ORDER) {
        if (other === f.urgency) continue;
        expect(
          new RegExp(`\\b${other}\\b`).test(help),
          `${f.key} is grouped as ${f.urgency} and its own sentence says "${other}": ${f.help}`,
        ).toBe(false);
      }
      // And it does not open by naming its own level either.
      expect(
        /^(urgent |page when|alert when|whisper when|quiet )/i.test(f.help),
        `${f.key} opens by restating its volume: ${f.help}`,
      ).toBe(false);
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
  // #1956: with nothing set, the floors are the MEASURED ones, not a coded pair.
  const at = Date.parse("2026-09-22T18:10:00Z"); // a Tuesday, 14:10 Eastern
  const measured = MEASURED_VOLUME_BASELINE.cells[1]![14]!;

  it("uses the measured floors when neither store nor env is set", () => {
    const policy = resolveFloors(null, {});
    expect(policy.baseline).toBe(MEASURED_VOLUME_BASELINE);
    expect(policy.override30).toBeNull();
    expect(policy.override120).toBeNull();
    const now = floorsFor(policy, at);
    expect([now.floor30, now.floor120]).toEqual([measured.floor30, measured.floor120]);
  });

  it("uses env as an override when the store is unset", () => {
    const policy = resolveFloors({ floor_30: null, floor_120: null, volume_ramp_end_on: null, volume_learning: null, calcom_retired_at: null }, { floor30: 7, floor120: 25 });
    expect(policy.override30).toEqual({ value: 7, origin: "env" });
    expect(policy.override120).toEqual({ value: 25, origin: "env" });
  });

  it("prefers the store over env (store wins)", () => {
    const policy = resolveFloors({ floor_30: 3, floor_120: 12, volume_ramp_end_on: null, volume_learning: null, calcom_retired_at: null }, { floor30: 7, floor120: 25 });
    expect(policy.override30).toEqual({ value: 3, origin: "stored" });
    expect(policy.override120).toEqual({ value: 12, origin: "stored" });
    const now = floorsFor(policy, at);
    expect(now.floor120).toBe(12);
    expect(now.measured120).toBe(measured.floor120);
  });

  it("accepts a stored floor of zero (a valid, meaningful override)", () => {
    const policy = resolveFloors({ floor_30: 0, floor_120: 0, volume_ramp_end_on: null, volume_learning: null, calcom_retired_at: null }, { floor30: 7, floor120: 25 });
    expect(policy.override30).toEqual({ value: 0, origin: "stored" });
    expect(policy.override120).toEqual({ value: 0, origin: "stored" });
  });

  it("ignores invalid stored floors (negative, non-integer) and falls through to env, then the measurement", () => {
    const policy = resolveFloors({ floor_30: -1, floor_120: 2.5, volume_ramp_end_on: null, volume_learning: null, calcom_retired_at: null }, { floor30: 7 });
    expect(policy.override30).toEqual({ value: 7, origin: "env" });
    expect(policy.override120).toBeNull();
  });
});

// #575: the low-volume ARMED switch moves into the store, precedence store > env >
// coded default (disarmed), so it can be flipped from the settings UI without a deploy.
describe("resolveFailureRateArmed", () => {
  // #1313 ships DISARMED (L56): a new detector observes one real cycle before it
  // is allowed to page, so a genuine first finding cannot page off a threshold
  // nobody has yet seen against real traffic.
  it("defaults to disarmed when the store has not been set", () => {
    expect(resolveFailureRateArmed(null)).toBe(false);
    expect(resolveFailureRateArmed({ failure_rate_armed: null })).toBe(false);
  });

  it("obeys an explicit stored decision in both directions", () => {
    expect(resolveFailureRateArmed({ failure_rate_armed: true })).toBe(true);
    expect(resolveFailureRateArmed({ failure_rate_armed: false })).toBe(false);
  });
});

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

  it("parses a checked toggle as armed=true", () => {
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "on" }).config.low_volume_armed).toBe(true);
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "true" }).config.low_volume_armed).toBe(true);
  });

  it("parses an absent/blank toggle as an explicit armed=false (saving disarms)", () => {
    expect(parseMonitorSettingsForm({ ...base, lowVolumeArmed: "" }).config.low_volume_armed).toBe(false);
  });
  // #2593: the below-tier page's own switch, parsed on its own field so arming one
  // alert can never arm another.
  it("parses the below-lead-tier toggle on its own field", () => {
    expect(parseMonitorSettingsForm({ ...base, belowLeadTierArmed: "on" }).config.below_lead_tier_armed).toBe(true);
    expect(parseMonitorSettingsForm({ ...base, belowLeadTierArmed: "" }).config.below_lead_tier_armed).toBe(false);
    expect(parseMonitorSettingsForm({ ...base, belowLeadTierArmed: "on" }).config.awaiting_activation_armed).toBe(false);
  });

  it("resolves the below-lead-tier switch DISARMED when unset", () => {
    expect(resolveBelowLeadTierArmed(null)).toBe(false);
    expect(resolveBelowLeadTierArmed({ below_lead_tier_armed: null })).toBe(false);
    expect(resolveBelowLeadTierArmed({ below_lead_tier_armed: true })).toBe(true);
  });

  it("gives the below-lead-tier family a real cooldown, so it can never page every tick", () => {
    expect(ALERT_KEYS).toContain("booking_below_lead_tier");
    expect(MONITOR_DEFAULTS.cooldownMs.booking_below_lead_tier).toBeGreaterThan(0);
  });
});
