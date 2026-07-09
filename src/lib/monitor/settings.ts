import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MonitorAlertConfig, MonitorSettings } from "@/lib/db/types";

/**
 * UI-tunable monitor alert settings (#571). Cooldowns and low-volume floors are
 * read from a store at runtime with precedence store > env > coded default; an
 * empty or unreadable store falls through to these defaults so alerting can never
 * be broken by its own config. The pure resolvers own precedence + validation;
 * `loadMonitorSettings` is a thin, error-safe DB wrapper around them.
 */

export type MonitorAlertKey =
  | "availability_data_anomaly"
  | "availability_booked_solid"
  | "fallback_covered_availability"
  | "low_booking_volume"
  | "thin_tier_staffing";

export const ALERT_KEYS: MonitorAlertKey[] = [
  "availability_data_anomaly",
  "availability_booked_solid",
  "fallback_covered_availability",
  "low_booking_volume",
  "thin_tier_staffing",
];

// Coded defaults (the pre-#571 compile-time constants). Cooldowns in ms.
export const MONITOR_DEFAULTS = {
  cooldownMs: {
    availability_data_anomaly: 30 * 60_000,
    availability_booked_solid: 6 * 60 * 60_000,
    fallback_covered_availability: 6 * 60 * 60_000,
    low_booking_volume: 30 * 60_000,
    // Proactive staffing nudge (#569): a slow, once-a-day whisper. Staffing
    // changes over days, so a long cooldown keeps it from repeating every tick.
    thin_tier_staffing: 24 * 60 * 60_000,
  },
  floor30: 5,
  floor120: 20,
} as const;

const validPositiveInt = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0;
const validNonNegInt = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Store cooldown-minutes (if valid & positive) → ms, else the coded default. */
export function resolveCooldownMs(
  rows: Pick<MonitorSettings, "key" | "cooldown_min">[],
): Record<MonitorAlertKey, number> {
  const byKey = new Map(rows.map((r) => [r.key, r.cooldown_min]));
  const out = {} as Record<MonitorAlertKey, number>;
  for (const k of ALERT_KEYS) {
    const stored = byKey.get(k);
    out[k] = validPositiveInt(stored) ? stored * 60_000 : MONITOR_DEFAULTS.cooldownMs[k];
  }
  return out;
}

/** Low-volume floors: store (valid, incl. 0) > env (valid) > coded default. */
export function resolveFloors(
  config: Pick<MonitorAlertConfig, "floor_30" | "floor_120"> | null,
  env: { floor30?: number; floor120?: number },
): { floor30: number; floor120: number } {
  const pick = (stored: number | null, envVal: number | undefined, def: number): number =>
    validNonNegInt(stored) ? stored : validNonNegInt(envVal) ? envVal : def;
  return {
    floor30: pick(config?.floor_30 ?? null, env.floor30, MONITOR_DEFAULTS.floor30),
    floor120: pick(config?.floor_120 ?? null, env.floor120, MONITOR_DEFAULTS.floor120),
  };
}

// Sane bounds so a fat-finger can't silently mute an alert for a week.
const COOLDOWN_MIN_MIN = 1;
const COOLDOWN_MIN_MAX = 7 * 24 * 60; // one week in minutes
const FLOOR_MIN = 0;
const FLOOR_MAX = 100_000;

export interface MonitorSettingsFormInput {
  cooldownMin: Record<MonitorAlertKey, string>;
  floor30: string;
  floor120: string;
  alertsChannel: string;
  infoChannel: string;
}

export interface MonitorSettingsPayload {
  cooldowns: { key: MonitorAlertKey; cooldown_min: number | null }[];
  config: {
    floor_30: number | null;
    floor_120: number | null;
    alerts_channel: string | null;
    info_channel: string | null;
  };
  errors: string[];
}

/**
 * Parses the admin form into a store payload. A blank field becomes explicit
 * `null` (revert to fallback), NEVER 0. Non-blank values outside their valid
 * range produce an error (the action should refuse to save rather than coerce).
 */
export function parseMonitorSettingsForm(input: MonitorSettingsFormInput): MonitorSettingsPayload {
  const errors: string[] = [];

  const parseBounded = (
    raw: string,
    label: string,
    min: number,
    max: number,
  ): number | null => {
    const t = (raw ?? "").trim();
    if (t === "") return null; // blank = unset = fall back
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label} must be a whole number between ${min} and ${max}.`);
      return null;
    }
    return n;
  };

  const cooldowns = ALERT_KEYS.map((key) => ({
    key,
    cooldown_min: parseBounded(input.cooldownMin[key] ?? "", `Cooldown (${key})`, COOLDOWN_MIN_MIN, COOLDOWN_MIN_MAX),
  }));

  const channel = (raw: string): string | null => {
    const t = (raw ?? "").trim();
    return t === "" ? null : t;
  };

  return {
    cooldowns,
    config: {
      floor_30: parseBounded(input.floor30, "30-min floor", FLOOR_MIN, FLOOR_MAX),
      floor_120: parseBounded(input.floor120, "120-min floor", FLOOR_MIN, FLOOR_MAX),
      alerts_channel: channel(input.alertsChannel),
      info_channel: channel(input.infoChannel),
    },
    errors,
  };
}

const parseEnvInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export interface ResolvedMonitorSettings {
  cooldownMs: Record<MonitorAlertKey, number>;
  floors: { floor30: number; floor120: number };
}

/**
 * Reads the store and resolves the monitor's runtime settings. NEVER throws:
 * any DB error (incl. the table not existing during a migrate-before-deploy
 * window) falls back to env/coded defaults so the monitor tick keeps alerting.
 */
export async function loadMonitorSettings(): Promise<ResolvedMonitorSettings> {
  let rows: Pick<MonitorSettings, "key" | "cooldown_min">[] = [];
  let config: Pick<MonitorAlertConfig, "floor_30" | "floor_120"> | null = null;
  try {
    const db = supabaseAdmin();
    const [cooldowns, cfg] = await Promise.all([
      db.from("monitor_settings").select("key, cooldown_min"),
      db.from("monitor_alert_config").select("floor_30, floor_120").eq("id", 1).maybeSingle(),
    ]);
    if (!cooldowns.error && cooldowns.data) {
      rows = cooldowns.data as Pick<MonitorSettings, "key" | "cooldown_min">[];
    }
    if (!cfg.error && cfg.data) {
      config = cfg.data as Pick<MonitorAlertConfig, "floor_30" | "floor_120">;
    }
  } catch {
    // Fall through to env/defaults (config must never take down alerting).
  }
  return {
    cooldownMs: resolveCooldownMs(rows),
    floors: resolveFloors(config, {
      floor30: parseEnvInt(process.env.BOOKING_VOLUME_FLOOR_30),
      floor120: parseEnvInt(process.env.BOOKING_VOLUME_FLOOR_120),
    }),
  };
}
