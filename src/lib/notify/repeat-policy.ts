/**
 * When a CONDITION alert may post again (#3801). Pure, so every rule here is pinned
 * by tests without a database or a clock.
 *
 * Over the week to 2026-10-16 the alerts channel took about 228 Slate messages and
 * roughly half were an unchanged fact said again on every cooldown, through the
 * night. Dan's decisions, 2026-10-16:
 *
 *   - an unchanged condition posts again 24 hours after its LAST post, not every
 *     cooldown ("Stop paging a million times overnight");
 *   - a CHANGE posts at once: a subject (an appointment, an agent, a pool, a tier,
 *     a lane) not named in the last post, or a measured value crossing into a worse
 *     band. A number drifting inside its band is not a change, and neither is a
 *     subject leaving: the all-clear reports the last one going;
 *   - the conditions whose meaning is that leads are being lost right now keep an
 *     hourly repeat (`URGENT_CONDITION_KEYS` in the catalog);
 *   - a stored `monitor_settings.cooldown_min` still decides a tunable alert's
 *     interval, so the settings page keeps working as the reminder interval;
 *   - incident and info alerts keep their own throttles, except the incidents in
 *     `CHANGE_ONLY_KEYS` (Dan, 2026-10-26), which take the change rule with no
 *     reminder and ignore the cooldown they are handed.
 *
 * The dispatcher (`sendThrottledAlert`) is the only caller, so every condition gets
 * the rule by construction rather than by each send site remembering it (L621).
 */
import { ALERT_KEYS, type MonitorAlertKey } from "@/lib/monitor/alert-keys";
import { alertKindOf, isChangeOnly, isUrgentCondition } from "@/lib/notify/alert-catalog";

/** How long an unchanged condition waits before it posts again. */
export const CONDITION_REPEAT_MS = 24 * 60 * 60_000;

/** The same, for an urgent condition: leads are being lost while it lasts. */
export const URGENT_CONDITION_REPEAT_MS = 60 * 60_000;

/**
 * How long an unchanged CHANGE ONLY incident (`CHANGE_ONLY_KEYS`) waits before it may
 * post again: in practice never. Finite rather than infinite because a failed send's
 * short retry stamp is worked out from the interval (`alertStampMs`), and a year is
 * longer than any key here lives: each is one booking, settled when the call comes
 * right and pruned once its time has passed.
 */
export const CHANGE_ONLY_HOLD_MS = 366 * 24 * 60 * 60_000;

/**
 * What a send site says about the condition it is posting, so the dispatcher can
 * tell a change from the same fact said again.
 *
 * - `subjects`: everything the message names that a reader would act on separately
 *   (booking ids, agent ids, pool codes, lane names). One not in the last post is a
 *   change. Omitted, the message's own normalised lines stand in for them
 *   (`signatureSubjects`), so a send site that says nothing still gets the daily
 *   repeat and still posts at once when its wording names something new. An EMPTY
 *   list is a real answer: the condition has no subjects, so only a worse band or
 *   the reminder can post it.
 * - `band`: a measured value as a band number, higher is worse (a count that has
 *   doubled, a rate past the next threshold). Rising into a higher band than the
 *   last post's is a change; anything else is not. Omitted, there is no band.
 *   A DURATION must never be a band: "has not run for N minutes" grows on every
 *   tick by construction, so it would post on every tick.
 * - `urgentSubjects`: for a key with a batch window (`changeBatchMs`), the subjects that
 *   may not wait for it, because they would be over before the batch posts (a call
 *   starting inside the window). A new one posts at once. Ignored by every other key.
 */
export interface AlertRepeat {
  subjects?: readonly string[];
  band?: number;
  urgentSubjects?: readonly string[];
}

/**
 * Change only keys whose NEW subjects are collected rather than posted one by one: a new
 * subject waits until this long has passed since the last post, unless the send marks it
 * urgent. Keyed by the catalog key.
 *
 *   - demoted_agent_bookings: 3 hours (Dan, 2026-10-26, asked how calls that get stuck
 *     after a page should arrive: "At most every 3 hours", with a call starting inside
 *     those 3 hours posting at once).
 */
export const CHANGE_BATCH_MS: Readonly<Record<string, number>> = {
  demoted_agent_bookings: 3 * 60 * 60_000,
};

/** The batch window for a SENT key, family members included, or null when it has none. */
export function changeBatchMs(key: string): number | null {
  if (!isChangeOnly(key)) return null;
  const base = key.split(":")[0] ?? key;
  return CHANGE_BATCH_MS[key] ?? CHANGE_BATCH_MS[base] ?? null;
}

/** The subjects the last post did not name. With nothing recorded, every one. */
export function freshSubjects(last: readonly string[] | null, subjects: readonly string[]): string[] {
  if (last === null) return [...subjects];
  const told = new Set(last);
  return subjects.filter((s) => !told.has(s));
}

/**
 * Whether new subjects wait for the batch: the last post was less than `batchMs` ago and
 * none of the new ones is urgent. A last post that cannot be dated holds nothing, which is
 * the loud side. An urgent subject that was ALREADY told does not count: it is not new, so
 * it cannot carry another subject past the window.
 */
export function heldForBatch(input: {
  batchMs: number;
  lastPostMs: number | null;
  nowMs: number;
  fresh: readonly string[];
  urgent: readonly string[];
}): boolean {
  const { batchMs, lastPostMs, nowMs, fresh, urgent } = input;
  if (fresh.length === 0 || lastPostMs === null) return false;
  if (nowMs - lastPostMs >= batchMs) return false;
  const pressing = new Set(urgent);
  return !fresh.some((s) => pressing.has(s));
}

/**
 * Families whose send key is not a settings key but whose cooldown IS read from
 * one, so a person tuning that setting is tuning them. Without this the floor below
 * would overrule a stored value for these. A family missing from here is the safe
 * direction to be wrong in: its stored override is ignored and it repeats on the
 * coded interval, which is daily or, when urgent, hourly.
 */
const BORROWED_SETTING: Readonly<Record<string, MonitorAlertKey>> = {
  low_tier_volume: "low_booking_volume",
  tier_volume_check_failed: "low_booking_volume",
  low_page_volume: "low_booking_volume",
  page_volume_share_unknown: "low_booking_volume",
  booking_api_ceiling: "booking_failure_rate",
  booking_api_credential: "booking_failure_rate",
  booking_api_list_read: "booking_failure_rate",
  // #3276: the volume page is held by the share page's cooldown, sent beside it.
  booking_failure_volume: "booking_failure_rate",
  // #1727: the embed booker's refusal pages read the same cooldown.
  booking_embed_ip_cap: "booking_failure_rate",
  booking_embed_contact_cap: "booking_failure_rate",
  booking_embed_honeypot: "booking_failure_rate",
};

const TUNABLE = new Set<string>(ALERT_KEYS);

/** The settings key whose stored cooldown governs `key`, or null when nobody can tune it. */
export function settingKeyFor(key: string): MonitorAlertKey | null {
  const base = key.split(":")[0] ?? key;
  if (TUNABLE.has(key)) return key as MonitorAlertKey;
  if (TUNABLE.has(base)) return base as MonitorAlertKey;
  return BORROWED_SETTING[base] ?? null;
}

/**
 * Whether the change rule applies to `key` at all: every condition, and the incidents
 * named in `CHANGE_ONLY_KEYS` (Dan, 2026-10-26), which take the change rule without
 * the reminder.
 */
export function isRepeatRuled(key: string): boolean {
  return alertKindOf(key) === "condition" || isChangeOnly(key);
}

/**
 * How long `key` waits after its last post before an unchanged condition posts again.
 *
 * - A change only incident (`CHANGE_ONLY_KEYS`): `CHANGE_ONLY_HOLD_MS`, whatever it is
 *   handed, so no stored or coded cooldown can bring back a repeat nobody wanted.
 * - Any other incident, and info: `cooldownMs`, exactly as before #3801.
 * - A tunable condition: `cooldownMs`, because the caller resolved it from the
 *   settings (a stored value, or the coded default in `MONITOR_DEFAULTS`, which
 *   #3801 set to the repeat above). This is how a stored override keeps winning.
 * - Any other condition: its cooldown is a coded constant somewhere in the tree, so
 *   the rule is applied HERE rather than in each of them: hourly when urgent, and
 *   otherwise never sooner than a day (a longer coded interval is kept).
 */
export function reminderIntervalMs(key: string, cooldownMs: number): number {
  if (isChangeOnly(key)) return CHANGE_ONLY_HOLD_MS;
  if (!isRepeatRuled(key)) return cooldownMs;
  const setting = settingKeyFor(key);
  const base = key.split(":")[0] ?? key;
  // Its own setting: whatever is stored, or the coded default, decides.
  if (setting !== null && (setting === key || setting === base)) return cooldownMs;
  // A BORROWED setting decides only for an urgent condition. The settings it borrows
  // are urgent ones (the low volume and failure rate pages), whose default is hourly,
  // so a condition that is not urgent riding on one would repeat hourly by accident;
  // it gets the day instead, and a longer stored value still wins.
  if (setting !== null) return isUrgentCondition(key) ? cooldownMs : Math.max(cooldownMs, CONDITION_REPEAT_MS);
  if (isUrgentCondition(key)) return URGENT_CONDITION_REPEAT_MS;
  return Math.max(cooldownMs, CONDITION_REPEAT_MS);
}

/**
 * One line of a message, reduced to what would change if the CONDITION changed.
 *
 * Every number goes (a count, a duration, a clock time, a run id), with the unit
 * that follows it, so "has not run for 515 minutes" and "575 minutes" read alike,
 * as do "3 appointments" and "5". Links go, since a run link differs on every run.
 * Agreement that follows a count goes too ("1 agent has" against "2 agents have"),
 * or a count crossing one would read as a new subject. What survives is the names:
 * an agent, a pool, a lane, a kind of failure.
 */
export function normalizeSignatureLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<link>")
    .replace(/\bjust now\b/g, "# ago")
    .replace(
      /\d+(?:[.,:]\d+)*(?:\s*(?:%|ms\b|seconds?\b|secs?\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|am\b|pm\b|[smhd]\b))?/g,
      "#",
    )
    // Every plural reads as its singular, wherever the count sits ("1 of 97 bookable
    // agent" against "2 of 97 bookable agents"). Applied to every word alike, so it only
    // has to be consistent, never correct English ("status" reads as "statu" on both
    // sides). A word ending in "ss" keeps its ending.
    .replace(/\b([a-z]{3,}?[^s\W])s\b/g, "$1")
    .replace(/\b(?:are|is)\b/g, "is")
    .replace(/\b(?:have|has)\b/g, "has")
    .replace(/\b(?:were|was)\b/g, "was")
    .replace(/#(?:\s*#)+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subjects a message names when its send site supplies none: its normalised
 * lines. Coarse on purpose, and the reason explicit subjects are preferred: a line
 * whose WORDING changes reads as a new subject, which posts once more than a
 * precise subject list would. That is the loud direction, and it is what lets a
 * send site that never heard of #3801 still post at once when it names somebody new.
 */
export function signatureSubjects(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const n = normalizeSignatureLine(line);
    if (n !== "") out.add(n);
  }
  return [...out].sort();
}

/** The subject set a send stores and compares: the explicit list, or the message's lines. */
export function subjectsFor(repeat: AlertRepeat | undefined, text: string): string[] {
  if (repeat?.subjects === undefined) return signatureSubjects(text);
  return [...new Set(repeat.subjects.map((s) => s.trim()).filter((s) => s !== ""))].sort();
}

/** What the last post of a condition said, as `alert_state` remembers it. */
export interface LastPost {
  /** Null when the row was written before #3801, or by an alert with no repeat rule. */
  subjects: readonly string[] | null;
  band: number | null;
}

export type RepeatChange = "unrecorded" | "new-subject" | "worse-band";

/**
 * Whether the post now in hand carries a change the last post did not, which is
 * the only reason a condition posts before its reminder is due.
 *
 * A last post with no recorded subjects is a change ("unrecorded"): the row was
 * written before this rule, so nothing can say what the reader was told, and the
 * loud answer is the safe one. It costs one post per open condition on the deploy
 * that ships this, after which every row carries its subjects.
 */
export function repeatChange(
  last: LastPost,
  subjects: readonly string[],
  band: number | null,
): RepeatChange | null {
  if (last.subjects === null) return "unrecorded";
  const told = new Set(last.subjects);
  if (subjects.some((s) => !told.has(s))) return "new-subject";
  if (band !== null && last.band !== null && band > last.band) return "worse-band";
  return null;
}

/**
 * A count's band, for a send site whose change is a count growing (#3801's "a count
 * that at least doubles"): 0 for 0 or 1, then one band per doubling. 2 to 3 is band
 * 1, 4 to 7 is band 2, and so on, so a count drifting inside its band is no change.
 */
export function doublingBand(count: number): number {
  if (!Number.isFinite(count) || count < 2) return 0;
  return Math.floor(Math.log2(count));
}

/** How long a condition has lasted, in the largest unit that reads naturally. */
export function formatConditionAge(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The reminder a condition posts once its interval runs out with nothing new
 * (#3801): the same message, under a first line saying it is a reminder and how
 * long the condition has lasted, so a reader can tell it from a new problem at a
 * glance. `sinceMs` is when the condition was first posted; `atLeast` says that
 * moment is not known exactly (a condition already open when #3801 shipped), so
 * the age is a floor rather than a measurement.
 */
export function formatReminder(text: string, since: { sinceMs: number; atLeast: boolean }, nowMs: number): string {
  const age = formatConditionAge(nowMs - since.sinceMs);
  const lead = since.atLeast
    ? `Reminder: still true after at least ${age}, with nothing new since the last message.`
    : `Reminder: still true after ${age}, with nothing new since the last message.`;
  return `${lead}\n${text}`;
}
