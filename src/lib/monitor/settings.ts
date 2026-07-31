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
  | "thin_tier_staffing"
  | "agents_without_schedule"
  | "agents_without_routing"
  | "migration_version_lag"
  | "sync_staleness"
  | "inactive_agent_bookings";

export const ALERT_KEYS: MonitorAlertKey[] = [
  "availability_data_anomaly",
  "availability_booked_solid",
  "fallback_covered_availability",
  "low_booking_volume",
  "thin_tier_staffing",
  "agents_without_schedule",
  "agents_without_routing",
  "migration_version_lag",
  "sync_staleness",
  "inactive_agent_bookings",
];

/**
 * The admin settings screen's cooldown fields, one per alert key. Kept beside
 * ALERT_KEYS rather than in the page so the two cannot drift: a key with no field
 * is a cooldown nobody can tune, and a field with no key is a control that does
 * nothing. A test asserts they stay in lockstep.
 */
export const ALERT_FIELDS: { key: MonitorAlertKey; label: string; help: string }[] = [
  {
    key: "availability_data_anomaly",
    label: "Data-anomaly page cooldown",
    help: "Urgent page when the cache disagrees with the calendars.",
  },
  {
    key: "availability_booked_solid",
    label: "Booked-solid notice cooldown",
    help: "Quiet notice when agents are genuinely full.",
  },
  {
    key: "fallback_covered_availability",
    label: "Fallback-covered notice cooldown",
    help: "Quiet notice when a thin tier is covered by the fallback.",
  },
  {
    key: "low_booking_volume",
    label: "Low-volume alert cooldown",
    help: "Throttle for the low-booking-volume alert.",
  },
  {
    key: "thin_tier_staffing",
    label: "Thin-tier staffing cooldown",
    help: "Quiet nudge when a tier rests on 1 to 2 bookable agents.",
  },
  {
    key: "agents_without_schedule",
    label: "Schedule-less agent cooldown",
    help: "Whisper when a bookable agent's working-hours schedule could not be auto-created.",
  },
  {
    key: "agents_without_routing",
    label: "Unroutable agent cooldown",
    help: "Whisper when a bookable agent has no routing attributes and no manual bucket membership, so they match no bucket.",
  },
  {
    key: "migration_version_lag",
    label: "Migration-lag page cooldown",
    help: "Urgent page when the live database is missing a migration the deployed code ships.",
  },
  {
    key: "sync_staleness",
    label: "Sync-staleness alert cooldown",
    help: "Alert when a bookable agent has not been calendar-synced for too long (the rotation is falling behind).",
  },
  {
    key: "inactive_agent_bookings",
    label: "Orphaned-appointment alert cooldown",
    help: "Alert when an agent who has left the booking pool (deactivated or not bookable) still holds future appointments, so those customers are booked with nobody.",
  },
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
    // Schedule-coverage gap (#838): the check self-heals first, so an alert means
    // the fill is broken and persists until a human acts. Once-a-day whisper, like
    // the thin-tier nudge; the settings screen can tighten it.
    agents_without_schedule: 24 * 60 * 60_000,
    // Routing-attribute gap (#226): a staffing/config gap that persists until a
    // human sets attributes or adds a manual member. Once-a-day whisper, like the
    // schedule-coverage and thin-tier nudges; the settings screen can tighten it.
    agents_without_routing: 24 * 60 * 60_000,
    // Schema behind the deployed code (#516). Repeats hourly while it persists:
    // it stays broken until a human runs db push, and a dormant schema gap has
    // twice gone unnoticed for a whole session, so it should keep asking.
    migration_version_lag: 60 * 60_000,
    // Sync-staleness (#241): the rotation being behind persists until the roster
    // shrinks or a stuck agent is fixed, so repeat while it lasts. Hourly, like the
    // migration-lag page; the settings screen can tighten it.
    sync_staleness: 60 * 60_000,
    // Orphaned appointments (#1215): a customer booked with an agent who has left
    // stays wrong until a human reassigns, and it only pages after an hour of the
    // gap standing open, so repeat while it lasts. Hourly, like the two above.
    inactive_agent_bookings: 60 * 60_000,
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

/**
 * Low-volume ARMED switch (#575): store (an explicit boolean) > env > coded
 * default (disarmed). A null store column is "unset" and falls through, exactly
 * like the floors; once the admin saves the settings form an explicit true/false
 * is written and the UI wins over the env in both directions.
 */
export function resolveLowVolumeArmed(
  config: Pick<MonitorAlertConfig, "low_volume_armed"> | null,
  envArmed: boolean | undefined,
): boolean {
  const stored = config?.low_volume_armed;
  if (typeof stored === "boolean") return stored;
  if (typeof envArmed === "boolean") return envArmed;
  return false;
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
  /** Raw value of the arm-low-volume checkbox ("on"/"true" when checked, else blank). */
  lowVolumeArmed: string;
}

export interface MonitorSettingsPayload {
  cooldowns: { key: MonitorAlertKey; cooldown_min: number | null }[];
  config: {
    floor_30: number | null;
    floor_120: number | null;
    alerts_channel: string | null;
    info_channel: string | null;
    low_volume_armed: boolean;
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

  // The checkbox is a definite on/off decision: checked -> armed, absent/blank ->
  // disarmed. Saving therefore always writes an explicit boolean, so the UI wins.
  const armedRaw = (input.lowVolumeArmed ?? "").trim().toLowerCase();
  const lowVolumeArmed = armedRaw === "on" || armedRaw === "true";

  return {
    cooldowns,
    config: {
      floor_30: parseBounded(input.floor30, "30-min floor", FLOOR_MIN, FLOOR_MAX),
      floor_120: parseBounded(input.floor120, "120-min floor", FLOOR_MIN, FLOOR_MAX),
      alerts_channel: channel(input.alertsChannel),
      info_channel: channel(input.infoChannel),
      low_volume_armed: lowVolumeArmed,
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
  /** #575: is the low-booking-volume alert armed (store > env > disarmed)? */
  lowVolumeArmed: boolean;
}

/**
 * Reads the store and resolves the monitor's runtime settings. NEVER throws:
 * any DB error (incl. the table not existing during a migrate-before-deploy
 * window) falls back to env/coded defaults so the monitor tick keeps alerting.
 */
export async function loadMonitorSettings(): Promise<ResolvedMonitorSettings> {
  let rows: Pick<MonitorSettings, "key" | "cooldown_min">[] = [];
  let config: Pick<MonitorAlertConfig, "floor_30" | "floor_120" | "low_volume_armed"> | null = null;
  try {
    const db = supabaseAdmin();
    const [cooldowns, cfg] = await Promise.all([
      db.from("monitor_settings").select("key, cooldown_min"),
      db
        .from("monitor_alert_config")
        .select("floor_30, floor_120, low_volume_armed")
        .eq("id", 1)
        .maybeSingle(),
    ]);
    if (!cooldowns.error && cooldowns.data) {
      rows = cooldowns.data as Pick<MonitorSettings, "key" | "cooldown_min">[];
    }
    if (!cfg.error && cfg.data) {
      config = cfg.data as Pick<MonitorAlertConfig, "floor_30" | "floor_120" | "low_volume_armed">;
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
    lowVolumeArmed: resolveLowVolumeArmed(config, envLowVolumeArmed()),
  };
}

/** The deploy-gated arm flag (#370), now only the fallback when the store is unset
 *  (#575). Undefined when the env var is absent, so the store/default can decide. */
export const envLowVolumeArmed = (): boolean | undefined => {
  const raw = process.env.BOOKING_VOLUME_ALERT_ARMED;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw === "1";
};
