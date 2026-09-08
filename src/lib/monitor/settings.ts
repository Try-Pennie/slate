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
  | "inactive_agent_bookings"
  | "coverage_needs_human"
  | "ooo_coverage_gap"
  | "ooo_calcom_unprotected"
  | "empty_buckets"
  | "booking_failure_rate"
  | "catchall_rate"
  | "availability_drift"
  | "booker_empty_reason"
  | "roster_coverage_gap"
  | "ooo_protection_lost"
  | "webhook_event_no_subscriber"
  | "edge_limiter_unusable"
  | "hydration_all_failing"
  | "calendar_window_uncovered"
  | "schedule_parity_drift"
  | "agents_on_unset_hours";

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
  "coverage_needs_human",
  "ooo_coverage_gap",
  "ooo_calcom_unprotected",
  "empty_buckets",
  "booking_failure_rate",
  "availability_drift",
  "booker_empty_reason",
  "roster_coverage_gap",
  "ooo_protection_lost",
  "webhook_event_no_subscriber",
  "edge_limiter_unusable",
  "hydration_all_failing",
  "calendar_window_uncovered",
  "schedule_parity_drift",
  "agents_on_unset_hours",
];

/**
 * The admin settings screen's cooldown fields, one per alert key. Kept beside
 * ALERT_KEYS rather than in the page so the two cannot drift: a key with no field
 * is a cooldown nobody can tune, and a field with no key is a control that does
 * nothing. A test asserts they stay in lockstep.
 */
/**
 * How loud an alert is, loudest first (#1955).
 *
 * Dan on the cooldowns section: "I hate everything about this. we can do so much
 * better than this design." One of the six faults was that it gave no sense of
 * which of these matter, while every `help` sentence said so in a word a reader
 * had to parse row by row. This is that word, as a FACT the section can group by
 * rather than something read back out of the prose (L192).
 *
 * The order is the order the section renders in, so a page is never below a
 * whisper. `settings.test.ts` holds every field to carrying one, holds every
 * level to being used, and holds each field's level to agreeing with its own
 * description, so the two cannot drift apart.
 */
export const ALERT_URGENCY_ORDER = ["page", "alert", "notice", "whisper"] as const;

export type AlertUrgency = (typeof ALERT_URGENCY_ORDER)[number];

/** What each level means, for the group heading. */
export const ALERT_URGENCY_COPY: Record<AlertUrgency, { label: string; meaning: string }> = {
  page: {
    label: "Pages",
    meaning: "Somebody is expected to act now.",
  },
  alert: {
    label: "Alerts",
    meaning: "Needs acting on, but not this minute.",
  },
  notice: {
    label: "Notices",
    meaning: "Worth knowing. Usually nothing is wrong.",
  },
  whisper: {
    label: "Whispers",
    meaning: "Logged for whoever goes looking.",
  },
};

export const ALERT_FIELDS: {
  key: MonitorAlertKey;
  label: string;
  help: string;
  /** REQUIRED, so `tsc` names a field added later with no level. */
  urgency: AlertUrgency;
}[] = [
  {
    key: "availability_data_anomaly",
    urgency: "page",
    label: "Data-anomaly page cooldown",
    help: "The cache disagrees with the calendars.",
  },
  {
    key: "availability_booked_solid",
    urgency: "notice",
    label: "Booked-solid notice cooldown",
    help: "Agents are genuinely full.",
  },
  {
    key: "fallback_covered_availability",
    urgency: "notice",
    label: "Fallback-covered notice cooldown",
    help: "A thin tier is covered by the fallback.",
  },
  {
    key: "low_booking_volume",
    urgency: "alert",
    label: "Low-volume alert cooldown",
    help: "Bookings in a window fell below the floor.",
  },
  {
    key: "thin_tier_staffing",
    urgency: "notice",
    label: "Thin-tier staffing cooldown",
    help: "A tier rests on 1 to 2 bookable agents.",
  },
  {
    key: "agents_without_schedule",
    urgency: "whisper",
    label: "Schedule-less agent cooldown",
    help: "A bookable agent's working hours schedule could not be auto created.",
  },
  {
    key: "agents_without_routing",
    urgency: "whisper",
    label: "Unroutable agent cooldown",
    help: "A bookable agent has no routing attributes and no manual bucket membership, so they match no bucket.",
  },
  {
    key: "migration_version_lag",
    urgency: "page",
    label: "Migration-lag page cooldown",
    help: "The live database is missing a migration the deployed code ships.",
  },
  {
    key: "sync_staleness",
    urgency: "alert",
    label: "Sync-staleness alert cooldown",
    help: "A bookable agent has not been calendar-synced for too long (the rotation is falling behind).",
  },
  {
    key: "inactive_agent_bookings",
    urgency: "alert",
    label: "Orphaned-appointment alert cooldown",
    help: "An agent who has left the booking pool (deactivated or not bookable) still holds future appointments, so those customers are booked with nobody.",
  },
  {
    key: "coverage_needs_human",
    urgency: "alert",
    label: "Stranded-appointment alert cooldown",
    help: "A coverage sweep could not move an appointment and gave up, so it is still with an agent who will not be there and only a person can place it.",
  },
  {
    key: "ooo_coverage_gap",
    urgency: "page",
    label: "Time off nobody has covered",
    help: "An agent on approved time off still holds an appointment starting within 48 hours that no coverage sweep has picked up, so that customer is booked with somebody who will not be there.",
  },
  {
    key: "calendar_window_uncovered",
    urgency: "page",
    label: "Calendar refresh not covering the booking window",
    help: "A bookable agent's calendar has not been refreshed far enough ahead to cover the days the booker offers, so a lead could book an hour that calendar already has taken.",
  },
  {
    key: "schedule_parity_drift",
    urgency: "alert",
    label: "Slate and cal.com disagree about the roster",
    help: "The daily comparison found an agent the two systems hold different working hours, days, timezone or pool membership for. While both systems are live this changes who a lead is booked with, or when, and nothing inside Slate can see it: a stored week is valid whether or not it matches the one the agent keeps.",
  },
  {
    key: "agents_on_unset_hours",
    urgency: "alert",
    label: "Agents offered on hours nobody set",
    help: "A bookable agent's working week is still the seeded default, so leads are offered times that are right only by coincidence. It ends when their hours are set by them, an admin, or the cal.com import.",
  },
  {
    key: "ooo_calcom_unprotected",
    urgency: "alert",
    label: "Time off not blocked in cal.com",
    help: "An agent is on approved time off right now with no cal.com block in place, so cal.com can still book them while they are away.",
  },
  {
    key: "availability_drift",
    urgency: "page",
    label: "Offered times that are not really free",
    help: "The times a bucket is offering turn out to be already busy on every eligible agent's real calendar, so customers would be refused at the last step.",
  },
  {
    key: "booking_failure_rate",
    urgency: "page",
    label: "Customers failing to book",
    help: "The share of booking attempts that fail over a rolling window crosses the threshold, so a wave of customers being turned away is caught as it happens rather than by complaints.",
  },
  {
    key: "booker_empty_reason",
    urgency: "page",
    label: "Booker cannot say why a week is empty",
    help: "The booker has no times to offer and cannot tell whether we are closed or fully booked, so a lead is shown a vague message instead of the reason.",
  },
  {
    key: "roster_coverage_gap",
    urgency: "page",
    label: "Advertised hours nobody is rostered for",
    help: "The org's business hours include time no agent is scheduled to work, so a lead is offered nothing during hours we say we are open.",
  },
  {
    key: "ooo_protection_lost",
    urgency: "page",
    label: "Approved time off no longer blocked",
    help: "An approved time off has no calendar event and no cached busy time covering it, so a lead can be booked into hours the agent is away.",
  },
  {
    key: "webhook_event_no_subscriber",
    urgency: "page",
    label: "Booking event nobody is subscribed to",
    help: "A booking event Slate sends has no active webhook endpoint subscribed to it, so the delivery is recorded and reaches no downstream system.",
  },
  {
    key: "edge_limiter_unusable",
    urgency: "page",
    label: "Request rate limits not being enforced",
    help: "The running deployment cannot use its request rate limits, so the public endpoints are open to unlimited traffic from one source. Clears itself once they are enforced again.",
  },
  {
    key: "hydration_all_failing",
    urgency: "page",
    label: "Calendar refresh failing on every calendar",
    help: "The daily calendar refresh has failed on every calendar it tried, several runs in a row. Bookings are unaffected while this lasts; what stops is the cached cover being renewed.",
  },
  {
    key: "empty_buckets",
    urgency: "alert",
    label: "Bucket with nobody to route to",
    help: "A booking bucket has no eligible bookable agent, so a lead sent there cannot be booked. A broad outage pages once for the whole set rather than once per bucket.",
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
    // Leads arriving with no usable routing code (#1908). Repeats hourly while it
    // persists: the cause is an upstream page building links without an xbc, which
    // stays broken until somebody fixes that page, and every hour it runs is more
    // leads booked with the wrong team.
    catchall_rate: 60 * 60_000,
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
    // Stranded appointments (#1242): the sweep has already given up, so the state
    // is terminal and stays wrong until a human places it. Repeat while it lasts,
    // hourly, like the orphaned-appointment page it sits beside.
    coverage_needs_human: 60 * 60_000,
    // An approved absence nobody has covered (#1238): the appointment is inside two
    // days, no sweep is on it, and nothing repairs it on its own, so it stays wrong
    // until a person places it. Hourly, like the two coverage pages it sits beside.
    ooo_coverage_gap: 60 * 60_000,
    // Time off not blocked in cal.com (#1253): the agent is away NOW and cal.com can
    // still book them, and the sweep is already retrying every 5 minutes, so a
    // shorter repeat than its neighbours. Half an hour keeps it present without
    // becoming the thing people mute.
    ooo_calcom_unprotected: 30 * 60_000,
    // A bookable agent's calendar no longer hydrated past the booking horizon
    // (#1262): stays wrong until the rotation reaches it or someone fixes the
    // account, so it repeats hourly like the coverage pages it sits beside.
    calendar_window_uncovered: 60 * 60_000,
    // Slate against cal.com drift (#2031). The sweep runs once a day, so anything
    // under a day cannot make it repeat and anything over it silences a day's
    // findings. A day means at most one page per sweep while drift sits unfixed,
    // which is the point: it is real, it is actionable, and it is invisible
    // anywhere else. Turn it up on the settings screen if a known drift is being
    // lived with, rather than muting the check.
    schedule_parity_drift: 24 * 60 * 60_000,
    // Hours nobody set (#1753): a slow condition that ends when a person or the
    // import writes the week, so once a day, like the other staffing nudges.
    agents_on_unset_hours: 24 * 60 * 60_000,
    // Routing dead zone (#327): unchanged from the constant this replaced. A bucket
    // with nobody stays wrong until someone is staffed onto it, so it repeats while
    // it lasts, six-hourly. Tunable since a deliberately dark roster (#1272) turned
    // it into sixty messages a wave with no way to quiet it.
    empty_buckets: 6 * 60 * 60_000,
    // Customers being turned away (#1313): an active outage costing bookings by
    // the minute, so it repeats faster than the staffing nudges. Half an hour is
    // long enough not to spam a live incident, short enough that a page missed at
    // the start of a wave comes back while it is still happening.
    booking_failure_rate: 30 * 60_000,
    // A drifted cache (#1315) keeps mis-selling times until the sync lane
    // reconverges, and the probe re-measures that bucket only once per rotation
    // (a few hours), so a fast repeat would say nothing new. Hourly, matching the
    // other conditions that persist until something is fixed.
    availability_drift: 60 * 60_000,
    // The booker unable to explain an empty week (#1420) is a config read that
    // stays broken until somebody fixes it, and the lane re-measures it every
    // minute, so a fast repeat would say nothing new. Hourly, matching the other
    // conditions that persist until something is fixed.
    booker_empty_reason: 60 * 60_000,
    // An advertised hour nobody covers (#1454) is not a fault that clears itself:
    // it ends when somebody edits a roster or the org's week, which is a staffing
    // decision measured in days, not a service that recovers. Hourly here would
    // repeat the same unchanged sentence twenty four times before anyone could
    // act on it, which is how a pager gets muted (L36). Daily.
    roster_coverage_gap: 24 * 60 * 60_000,
    // Approved time off blocking nothing (#1467): the agent is away and a lead can
    // be booked into those hours right now, and nothing repairs it on its own (the
    // request still records the block as written, so no retry acts on it). It stays
    // wrong until a person opens the request, so repeat while it lasts. Hourly,
    // like the orphaned and stranded appointment pages it sits beside.
    ooo_protection_lost: 60 * 60_000,
    // An event reaching nobody (#1459) persists until a person updates the
    // endpoint's events array, which is a database edit no deploy will do. Repeat
    // daily rather than hourly: the fix is not urgent to the minute, and the state
    // can legitimately last as long as the person who has to make that edit is away.
    webhook_event_no_subscriber: 24 * 60 * 60_000,
    // The request ceilings being off (#1529) persists until a deploy puts them back, and
    // nothing self-heals it, so repeat while it lasts. Hourly rather than daily: unlike an
    // unsubscribed webhook event, the state leaves a public endpoint unprotected, and
    // unlike the fail-open incident it replaces, this one can say when it is over.
    edge_limiter_unusable: 60 * 60_000,
    // The refresh failing everywhere (#1544) persists until somebody fixes the cause, and
    // nothing self-heals it, so repeat while it lasts. Every 6 hours rather than hourly:
    // cached cover has weeks of margin before it stops reaching the booking horizon, so this
    // is a maintenance problem to pick up in the working day, not an outage to page on.
    hydration_all_failing: 6 * 60 * 60_000,
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

/**
 * A cooldown in minutes as a person would say it: "30 minutes", "6 hours",
 * "7 days". The stored numbers run from single minutes to 10080, and a reader
 * comparing 10080 against 360 has to do arithmetic to see that one is a week and
 * the other six hours, which is the whole thing #1289 is trying to make obvious.
 * Falls back to minutes for anything that does not divide cleanly, so the number
 * is never rounded into a different value.
 */
export function formatMinutes(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes >= 1440 && minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes >= 60 && minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/** One alarm whose stored cooldown is longer than its coded default (#1289). */
export interface QuietedAlarm {
  key: MonitorAlertKey;
  /** The same label the settings screen shows, so the two never diverge. */
  label: string;
  /** The stored cooldown, in minutes. Always greater than `defaultMinutes`. */
  storedMinutes: number;
  defaultMinutes: number;
  /** When the stored value last changed, so the reason can be traced. */
  updatedAt: string | null;
}

/**
 * Every alarm currently QUIETER than its coded default, worst first (#1289).
 *
 * Two cooldowns were stretched to a weekly repeat on purpose while the routing
 * pool is off (#1272, #1283) and nothing in the product said so. An alarm quieted
 * for a good reason is indistinguishable from an alarm that was always quiet.
 *
 * Derived from `MONITOR_DEFAULTS` and the SAME validity rule `resolveCooldownMs`
 * applies, never a second copy of either. That matters because a stored 0, a
 * negative, or a fraction is IGNORED by the resolver, which falls back to the
 * default: such a row quiets nothing, and reporting it would send somebody to fix
 * a setting that is already correct. A row for a key the code no longer sends is
 * ignored for the same reason.
 */
export function quietedAlarms(
  rows: Pick<MonitorSettings, "key" | "cooldown_min" | "updated_at">[],
): QuietedAlarm[] {
  const labels = new Map(ALERT_FIELDS.map((f) => [f.key, f.label]));
  const effective = resolveCooldownMs(rows);
  const out: QuietedAlarm[] = [];
  for (const row of rows) {
    const key = row.key as MonitorAlertKey;
    if (!labels.has(key)) continue;
    const defaultMinutes = MONITOR_DEFAULTS.cooldownMs[key] / 60_000;
    // Compare the EFFECTIVE cooldown, which is what the alerts actually use, so
    // a value the resolver discarded can never be reported as quieting anything.
    const storedMinutes = effective[key] / 60_000;
    if (storedMinutes <= defaultMinutes) continue;
    out.push({
      key,
      label: labels.get(key)!,
      storedMinutes,
      defaultMinutes,
      updatedAt: row.updated_at ?? null,
    });
  }
  return out.sort(
    (a, b) => b.storedMinutes / b.defaultMinutes - a.storedMinutes / a.defaultMinutes,
  );
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
 * The arming precedence, shared by every arm/disarm switch: an explicit stored
 * boolean > env (where one exists) > the coded default, which is always DISARMED.
 * A null store column is "unset" and falls through, exactly like the floors; once
 * the admin saves the settings form an explicit true/false is written and the UI
 * wins in both directions.
 *
 * One implementation on purpose. Two switches resolving "unset" by their own copy
 * of this rule is how they drift, and the direction they drift in (a flag reading
 * armed when nobody armed it) is the one that pages off an uncalibrated threshold.
 */
function resolveArmed(stored: boolean | null | undefined, envArmed?: boolean): boolean {
  if (typeof stored === "boolean") return stored;
  if (typeof envArmed === "boolean") return envArmed;
  return false;
}

/** Low-volume ARMED switch (#575): store > env (BOOKING_VOLUME_ALERT_ARMED) >
 *  disarmed. */
export function resolveLowVolumeArmed(
  config: Pick<MonitorAlertConfig, "low_volume_armed"> | null,
  envArmed: boolean | undefined,
): boolean {
  return resolveArmed(config?.low_volume_armed, envArmed);
}

/**
 * Booking-failure-rate ARMED switch (#1313): store > disarmed. No env fallback,
 * unlike its low-volume sibling: that one predates the store and kept its env var
 * for the cutover, whereas this ships with the admin toggle from day one, and a
 * second way to arm it would just be a second place for the answer to hide.
 *
 * The disarmed default is L56: a new detector must observe one real cycle before
 * it may page, so its first live run is not also its first enforcing run. The
 * issue that arms it is filed alongside this one (L65).
 */
export function resolveFailureRateArmed(
  config: Pick<MonitorAlertConfig, "failure_rate_armed"> | null,
): boolean {
  return resolveArmed(config?.failure_rate_armed);
}

/** Availability-truth ARMED switch (#1315): store > disarmed, same shape and
 *  same observe-first reasoning as its sibling above. */
export function resolveAvailabilityDriftArmed(
  config: Pick<MonitorAlertConfig, "availability_drift_armed"> | null,
): boolean {
  return resolveArmed(config?.availability_drift_armed);
}

/**
 * Roster-coverage ARMED switch (#1454): store > disarmed, same shape as its three
 * siblings above.
 *
 * The disarmed default is NOT the usual observe-a-cycle-first reasoning. This
 * check counts bookable agents, and the roster is deliberately dark before
 * cutover (#1272), so an armed check would report the whole advertised week
 * uncovered on every tick until go-live: correct, useless, and muted long before
 * the day it starts telling the truth. It measures and logs throughout.
 */
export function resolveRosterCoverageArmed(
  config: Pick<MonitorAlertConfig, "roster_coverage_armed"> | null,
): boolean {
  return resolveArmed(config?.roster_coverage_armed);
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
  /** Raw value of the arm-failure-rate checkbox (#1313), same encoding. */
  failureRateArmed: string;
  /** Raw value of the arm-availability-drift checkbox (#1315), same encoding. */
  availabilityDriftArmed: string;
  rosterCoverageArmed: string;
}

export interface MonitorSettingsPayload {
  cooldowns: { key: MonitorAlertKey; cooldown_min: number | null }[];
  config: {
    floor_30: number | null;
    floor_120: number | null;
    alerts_channel: string | null;
    info_channel: string | null;
    low_volume_armed: boolean;
    failure_rate_armed: boolean;
    availability_drift_armed: boolean;
    roster_coverage_armed: boolean;
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
  const checked = (raw: string): boolean => {
    const t = (raw ?? "").trim().toLowerCase();
    return t === "on" || t === "true";
  };

  return {
    cooldowns,
    config: {
      floor_30: parseBounded(input.floor30, "30-min floor", FLOOR_MIN, FLOOR_MAX),
      floor_120: parseBounded(input.floor120, "120-min floor", FLOOR_MIN, FLOOR_MAX),
      alerts_channel: channel(input.alertsChannel),
      info_channel: channel(input.infoChannel),
      low_volume_armed: checked(input.lowVolumeArmed),
      failure_rate_armed: checked(input.failureRateArmed),
      availability_drift_armed: checked(input.availabilityDriftArmed),
      roster_coverage_armed: checked(input.rosterCoverageArmed),
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
  /** #1313: is the booking-failure-rate page armed (store > disarmed)? */
  failureRateArmed: boolean;
  /** #1315: is the availability-truth page armed (store > disarmed)? */
  availabilityDriftArmed: boolean;
  /** #1454: is the roster-coverage page armed (store > disarmed)? */
  rosterCoverageArmed: boolean;
}

/**
 * Reads the store and resolves the monitor's runtime settings. NEVER throws:
 * any DB error (incl. the table not existing during a migrate-before-deploy
 * window) falls back to env/coded defaults so the monitor tick keeps alerting.
 */
export async function loadMonitorSettings(): Promise<ResolvedMonitorSettings> {
  let rows: Pick<MonitorSettings, "key" | "cooldown_min">[] = [];
  let config:
    | Pick<
        MonitorAlertConfig,
        | "floor_30"
        | "floor_120"
        | "low_volume_armed"
        | "failure_rate_armed"
        | "availability_drift_armed"
        | "roster_coverage_armed"
      >
    | null = null;
  try {
    const db = supabaseAdmin();
    const [cooldowns, cfg] = await Promise.all([
      db.from("monitor_settings").select("key, cooldown_min"),
      db
        .from("monitor_alert_config")
        .select(
          "floor_30, floor_120, low_volume_armed, failure_rate_armed, availability_drift_armed, roster_coverage_armed",
        )
        .eq("id", 1)
        .maybeSingle(),
    ]);
    if (!cooldowns.error && cooldowns.data) {
      rows = cooldowns.data as Pick<MonitorSettings, "key" | "cooldown_min">[];
    }
    if (!cfg.error && cfg.data) {
      config = cfg.data as Pick<
        MonitorAlertConfig,
        | "floor_30"
        | "floor_120"
        | "low_volume_armed"
        | "failure_rate_armed"
        | "availability_drift_armed"
        | "roster_coverage_armed"
      >;
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
    failureRateArmed: resolveFailureRateArmed(config),
    availabilityDriftArmed: resolveAvailabilityDriftArmed(config),
    rosterCoverageArmed: resolveRosterCoverageArmed(config),
  };
}

/** The deploy-gated arm flag (#370), now only the fallback when the store is unset
 *  (#575). Undefined when the env var is absent, so the store/default can decide. */
export const envLowVolumeArmed = (): boolean | undefined => {
  const raw = process.env.BOOKING_VOLUME_ALERT_ARMED;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw === "1";
};
