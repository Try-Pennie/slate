"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  currentUser,
  realCurrentUser,
  requireAdmin,
  requireManager,
} from "@/lib/auth";
import {
  IMPERSONATE_COOKIE,
  IMPERSONATE_TTL_SECONDS,
  encodeImpersonationCookie,
  impersonationTargetId,
} from "@/lib/auth/impersonation";
import {
  atLeast,
  canImpersonate,
  canManageUser,
  canChangeRole,
  canSetRole,
  isRole,
  isSelfDemotion,
  roleLabel,
} from "@/lib/auth/roles";
import { roundUpToQuarterHour } from "@/lib/date/parse";
import { upsertUserSchedule } from "@/lib/schedule";
import { SEED_START_TIME, SEED_END_TIME } from "@/lib/schedule-core";
import {
  parseBusinessHoursForm,
  countBookingsOnWeekdays,
} from "@/lib/booking/business-hours-form";
import { loadBusinessHoursRows } from "@/lib/booking/business-hours-load";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { selectAllPages } from "@/lib/supabase/paginate";
import { applyBookableByUserId } from "@/lib/bookable/service";
import { applyLifecycleByUserId } from "@/lib/offboarding/service";
import { syncSalesforceAgents, AGENTS_SYNC_STREAK_KEY } from "@/lib/salesforce/sync";
import { clearFailureStreak } from "@/lib/notify/streak";
import { replayDeadLetteredDeliveries, resendDelivery } from "@/lib/webhooks/emit";
import { webhookUrlError } from "@/lib/webhooks/url";
import { acquireLock } from "@/lib/locks";
import { recordAudit, type AuditAction } from "@/lib/audit";
import { impersonationErrorUrl } from "@/lib/admin/imp-error-url";
import {
  parseMonitorSettingsForm,
  ALERT_KEYS as MONITOR_ALERT_KEYS,
  type MonitorAlertKey,
} from "@/lib/monitor/settings";
import {
  coerceReasonOptionsForm,
  parseReasonOptionsForm,
} from "@/lib/booking/reason-options";
import {
  parseDefaultBucketForm,
  parseHorizonForm,
  parseEventDescriptionForm,
} from "@/lib/booking/settings";
import { markAllBucketSlotsStale } from "@/lib/availability/precompute";
import { updateEventType } from "@/lib/availability/event-type-store";
import { log } from "@/lib/log";
import { __clearChannelCache } from "@/lib/notify/channels";
import { planScheduleReplacement } from "@/lib/schedule-replacement";
import type { Attributes, Criteria, Role, User } from "@/lib/db/types";

/**
 * Asserts the signed-in user is a manager+ who may edit `userId` (escalation
 * guard: a manager can edit agents but not peers/admins). Returns the actor.
 */
async function requireManageAgent(
  userId: string,
  action: AuditAction,
): Promise<User> {
  const actor = await requireManager();
  const { data } = await supabaseAdmin()
    .from("users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  const targetRole = (data as { role: Role } | null)?.role ?? "agent";
  if (!canManageUser(actor.role, targetRole, actor.id === userId)) {
    throw new Error("Not authorized");
  }
  await recordAudit({ orgId: actor.org_id, actorId: actor.id, action, targetUserId: userId });
  return actor;
}

/**
 * Replaces a user's weekly schedule (one schedule row + its rules), atomically
 * (#1293).
 *
 * Three things this must never do, because each one silently removes an agent from
 * every bucket's availability while reporting a successful save:
 *
 *   1. Apply an input that cannot produce a real week. Refused BEFORE anything is
 *      written, with a message for the person who pressed save.
 *   2. Leave the schedule half written. The delete and the insert are one
 *      transaction inside `replace_availability_rules` (migration 0097), so a
 *      failure keeps the previous rules rather than clearing them.
 *   3. Swallow the write's error. It throws, which the server action surfaces.
 */
async function replaceUserSchedule(
  userId: string,
  timezone: string,
  weekdays: number[],
  startMinute: number,
  endMinute: number,
): Promise<void> {
  const plan = planScheduleReplacement(weekdays, startMinute, endMinute);
  if (!plan.ok) throw new Error(plan.error);

  const db = supabaseAdmin();
  const scheduleId = await upsertUserSchedule(userId, timezone);
  const { data, error } = await db.rpc("replace_availability_rules", {
    p_schedule_id: scheduleId,
    p_rules: plan.rules,
  });
  if (error) {
    throw new Error(`Your hours could not be saved: ${error.message}`);
  }
  // Claim success only on the count the database reports, never on the absence of
  // an error: a write that landed a different number of rules than asked for is a
  // silently wrong schedule, and this is the last place that can tell.
  const written = typeof data === "number" ? data : Number.NaN;
  if (written !== plan.rules.length) {
    throw new Error(
      `Your hours could not be saved: expected ${plan.rules.length} days, the database recorded ${Number.isFinite(written) ? written : "an unreadable count"}.`,
    );
  }
}

/** Applies the org default schedule to a user, keeping their tz if already set. */
async function applyOrgDefaultToUser(
  orgId: string,
  userId: string,
): Promise<void> {
  const db = supabaseAdmin();
  const { data: org } = await db
    .from("organizations")
    .select(
      "default_timezone, default_start_minute, default_end_minute, default_weekdays",
    )
    .eq("id", orgId)
    .single();
  const o = org as {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };
  const { data: existing } = await db
    .from("availability_schedules")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const tz =
    (existing as { timezone: string } | null)?.timezone ?? o.default_timezone;
  await replaceUserSchedule(
    userId,
    tz,
    o.default_weekdays,
    o.default_start_minute,
    o.default_end_minute,
  );
}

const weekdaysFrom = (form: FormData): number[] =>
  [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`day_${d}`));

/** Agent self-service: set my own working hours. */
export async function setMyWorkingHours(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) return;
  await replaceUserSchedule(
    me.id,
    String(form.get("timezone") ?? "America/New_York"),
    weekdaysFrom(form),
    toMinutes(String(form.get("start") ?? "09:00")),
    toMinutes(roundUpToQuarterHour(String(form.get("end") ?? "17:00"))),
  );
  revalidatePath("/me");
}

/** Agent self-service: apply the org default hours to myself. */
export async function useMyDefaultHours(): Promise<void> {
  const me = await currentUser();
  if (!me) return;
  await applyOrgDefaultToUser(me.org_id, me.id);
  revalidatePath("/me");
}

export async function syncSalesforceNow(): Promise<void> {
  await requireAdmin();
  let summary: string;
  try {
    const r = await syncSalesforceAgents();
    const plural = (n: number, one: string, many = `${one}s`) =>
      `${n} ${n === 1 ? one : many}`;
    const parts = [
      `${r.updated + r.inserted} agents synced`,
      r.inserted ? `${r.inserted} added` : null,
      r.managersLinked
        ? `${plural(r.managersLinked, "agent")} reassigned to a manager`
        : null,
      r.managersCreated ? `${plural(r.managersCreated, "new manager")}` : null,
      r.managersPromoted ? `${r.managersPromoted} promoted to manager` : null,
      r.deactivated ? `${plural(r.deactivated, "user")} deactivated` : null,
    ].filter(Boolean);
    summary =
      parts.length > 1 ? parts.join(" · ") : `${parts[0]} (already up to date)`;
    // A successful hand remediation fully quiets the hourly cron's alarm (#491):
    // clear its consecutive-failure streak so the next automatic hiccup starts
    // from zero instead of re-alerting on a problem the admin just fixed.
    await clearFailureStreak(AGENTS_SYNC_STREAK_KEY);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    revalidatePath("/admin");
    redirect(`/admin?sync_error=${encodeURIComponent(message.slice(0, 200))}`);
  }
  revalidatePath("/admin");
  redirect(`/admin?synced=${encodeURIComponent(summary)}`);
}

function num(form: FormData, key: string, fallback: number): number {
  const v = form.get(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export async function createEventType(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await supabaseAdmin().from("event_types").insert({
    org_id: admin.org_id,
    name: String(form.get("name") ?? "Consult"),
    description: String(form.get("description") ?? "").trim() || null,
    regal_type: String(form.get("regal_type") ?? "call").trim() || "call",
    duration_min: num(form, "duration_min", 30),
    buffer_before_min: num(form, "buffer_before_min", 0),
    buffer_after_min: num(form, "buffer_after_min", 0),
    min_notice_min: num(form, "min_notice_min", 120),
    daily_cap: form.get("daily_cap") ? num(form, "daily_cap", 0) : null,
    slot_interval_min: num(form, "slot_interval_min", 15),
  });
  revalidatePath("/admin");
}

/**
 * Routing criteria from the editor's dynamic `crit_<key>` checkboxes. Any key
 * is allowed (no hardcoded list), so new attribute dimensions need no deploy;
 * the admin UI offers only keys/values that exist on agents (see catalog.ts).
 * Repeated `crit_<key>` values become an array (matchesCriteria intersects).
 */
function criteriaFromForm(form: FormData): Criteria {
  const out: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("crit_") || typeof v !== "string") continue;
    const val = v.trim();
    if (!val) continue;
    (out[k.slice(5)] ??= []).push(val);
  }
  return out;
}

async function replaceBucketMembers(
  bucketId: string,
  memberIds: string[],
): Promise<void> {
  const db = supabaseAdmin();
  await db.from("bucket_members").delete().eq("bucket_id", bucketId);
  if (memberIds.length) {
    await db
      .from("bucket_members")
      .insert(memberIds.map((user_id) => ({ bucket_id: bucketId, user_id })));
  }
}

export async function createBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const memberIds = form.getAll("members").map(String).filter(Boolean);

  const { data: bucket, error } = await supabaseAdmin()
    .from("buckets")
    .insert({
      org_id: admin.org_id,
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      event_type_id: String(form.get("event_type_id") ?? ""),
      criteria: criteriaFromForm(form),
      routing_form_id: String(form.get("routing_form_id") ?? "").trim() || null,
      fallback_user_id: String(form.get("fallback_user_id") ?? "") || null,
    })
    .select("id")
    .single();

  if (!error && bucket && memberIds.length) {
    await replaceBucketMembers((bucket as { id: string }).id, memberIds);
  }
  revalidatePath("/admin");
}

export async function updateBucket(form: FormData): Promise<void> {
  await requireAdmin();
  const id = String(form.get("bucket_id") ?? "");
  if (!id) return;

  await supabaseAdmin()
    .from("buckets")
    .update({
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      event_type_id: String(form.get("event_type_id") ?? ""),
      criteria: criteriaFromForm(form),
      routing_form_id: String(form.get("routing_form_id") ?? "").trim() || null,
      fallback_user_id: String(form.get("fallback_user_id") ?? "") || null,
    })
    .eq("id", id);

  await replaceBucketMembers(id, form.getAll("members").map(String).filter(Boolean));
  revalidatePath("/admin");
}

export async function setWorkingHours(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  await requireManageAgent(userId, "agent.hours");
  const timezone = String(form.get("timezone") ?? "America/New_York");
  const startMinute = toMinutes(String(form.get("start") ?? "09:00"));
  const endMinute = toMinutes(roundUpToQuarterHour(String(form.get("end") ?? "17:00")));
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) =>
    form.get(`day_${d}`),
  );

  // One schedule per user (enforced by the availability_schedules(user_id)
  // unique index, #532): replaceUserSchedule upserts it, then replaces its rules.
  await replaceUserSchedule(userId, timezone, weekdays, startMinute, endMinute);
  revalidatePath("/admin");
}

/**
 * Saves the UI-tunable monitor alert settings (#571). Blank fields revert to
 * fallback (explicit null, never 0); out-of-range values are refused. Each row is
 * written as one complete object so clearing one field can't wipe a sibling.
 */
export async function setMonitorSettings(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const cooldownMin = Object.fromEntries(
    MONITOR_ALERT_KEYS.map((k) => [k, String(form.get(`cooldown_${k}`) ?? "")]),
  ) as Record<MonitorAlertKey, string>;

  const parsed = parseMonitorSettingsForm({
    cooldownMin,
    floor30: String(form.get("floor_30") ?? ""),
    floor120: String(form.get("floor_120") ?? ""),
    alertsChannel: String(form.get("alerts_channel") ?? ""),
    infoChannel: String(form.get("info_channel") ?? ""),
    lowVolumeArmed: String(form.get("low_volume_armed") ?? ""),
    failureRateArmed: String(form.get("failure_rate_armed") ?? ""),
    availabilityDriftArmed: String(form.get("availability_drift_armed") ?? ""),
    rosterCoverageArmed: String(form.get("roster_coverage_armed") ?? ""),
  });

  if (parsed.errors.length) {
    redirect(`/admin/settings?error=${encodeURIComponent(parsed.errors.join(" "))}`);
  }

  const db = supabaseAdmin();
  const now = new Date().toISOString();
  await db.from("monitor_settings").upsert(
    parsed.cooldowns.map((c) => ({
      key: c.key,
      cooldown_min: c.cooldown_min,
      updated_at: now,
      updated_by: admin.id,
    })),
    { onConflict: "key" },
  );
  await db
    .from("monitor_alert_config")
    .upsert({ id: 1, ...parsed.config, updated_at: now, updated_by: admin.id }, { onConflict: "id" });

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "monitor.settings",
    details: { cooldowns: parsed.cooldowns, config: parsed.config },
  });
  // Channels are cached in-process; clear so the new destination takes effect now.
  __clearChannelCache();
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=1");
}

/**
 * Save the direct-booking default bucket (#1016, phase 2 of #541). Admin-only.
 * The selection is validated against the current non-test bucket codes so we
 * never persist a code that points at no bucket; blank clears the default. The
 * write is a single keyed upsert on id=1 (assume-it-runs-twice: idempotent,
 * last-writer-wins).
 */
export async function setDefaultBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  // The valid set = current non-test bucket codes (a test bucket must never be
  // the public default). Roster-bounded (~60 buckets), so a single page holds all.
  const { data: buckets } = await db
    .from("buckets")
    .select("code, is_test")
    .eq("is_test", false);
  const validCodes = new Set(((buckets ?? []) as { code: string }[]).map((b) => b.code));

  const parsed = parseDefaultBucketForm(String(form.get("default_bucket_code") ?? ""), validCodes);
  if (parsed.errors.length) {
    redirect(`/admin/settings?error=${encodeURIComponent(parsed.errors.join(" "))}`);
  }

  await db.from("booking_settings").upsert(
    {
      id: 1,
      default_bucket_code: parsed.default_bucket_code,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { default_bucket_code: parsed.default_bucket_code },
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=1");
}

/**
 * Save the org-wide booking horizon (#216). Admin-only. The value is validated to
 * the 1..7 range (blank clears the override, falling back to env/coded default);
 * an out-of-range value redirects with an error and NEVER writes. The write is a
 * column-scoped upsert on id=1 (so it can't clobber default_bucket_code) and is
 * idempotent (assume-it-runs-twice). On a successful save every precomputed row is
 * marked stale so the recompute lane rebuilds rows over the NEW window promptly
 * (refresh-on-save); a failure there only logs, because the freshness window still
 * backstops convergence and must not fail the save.
 */
export async function setBookingHorizon(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const parsed = parseHorizonForm(String(form.get("horizon_days") ?? ""));
  if (parsed.errors.length) {
    redirect(`/admin/settings?error=${encodeURIComponent(parsed.errors.join(" "))}`);
  }

  await db.from("booking_settings").upsert(
    {
      id: 1,
      horizon_days: parsed.horizon_days,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );

  // Refresh-on-save: converge rows onto the new window now, not only as they age.
  try {
    await markAllBucketSlotsStale();
  } catch (err) {
    log.error("admin", { msg: "horizon save: row invalidation failed" }, err);
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { horizon_days: parsed.horizon_days },
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=1");
}

/**
 * Save the description a lead reads before booking (#1335).
 *
 * Admin only, guarding independently of the page gate. It was previously settable
 * only when an event type was CREATED, so changing the one that already exists
 * needed an engineer, and Dan's rewrite on 2026-08-07 should be the last time that
 * is true. The second half of that copy is a real instruction that changes how the
 * call goes, and it will want tuning once advisors report back.
 *
 * Keyed on the event type id from the form, so an org with more than one is not
 * quietly editing whichever happened to be first.
 *
 * The write is a plain UPDATE on one column, so it is idempotent under a retry or
 * a double submit (assume it runs twice). Its result is CHECKED rather than
 * discarded: a failed save that redirected to a cheerful "Saved" would leave the
 * old copy in front of every lead while telling the author it had changed, which is
 * the exact shape of a success claimed over a write that never committed (L12).
 */
export async function setEventDescription(form: FormData): Promise<void> {
  const admin = await requireAdmin();

  const eventTypeId = String(form.get("event_type_id") ?? "").trim();
  if (!eventTypeId) {
    redirect(`/admin/settings?error=${encodeURIComponent("No event type was named.")}`);
  }

  const parsed = parseEventDescriptionForm(String(form.get("description") ?? ""));
  if (parsed.errors.length) {
    redirect(`/admin/settings?error=${encodeURIComponent(parsed.errors.join(" "))}`);
  }

  // #1435: one helper owns the write AND the refresh of what the booker serves,
  // because the description rides inside the cached slots payload and editing the
  // row is not the same as serving it. Nothing else in src/ may write this table
  // (scripts/test-event-type-writes.ts), so the next editor added here cannot ship
  // the stale-copy defect by forgetting a step.
  const saved = await updateEventType({
    eventTypeId,
    orgId: admin.org_id,
    patch: { description: parsed.description },
  });
  if (saved.error) {
    log.error(
      "admin",
      { msg: "event description save failed", event_type_id: eventTypeId },
      saved.error,
    );
    redirect(
      `/admin/settings?error=${encodeURIComponent("Could not save the description. Please try again.")}`,
    );
  }
  // Zero rows is not a success either: the id did not match anything this admin's
  // org owns, so nothing changed and saying otherwise would be a lie about somebody
  // else's data as much as about theirs.
  if (saved.count === 0) {
    redirect(
      `/admin/settings?error=${encodeURIComponent("That event type was not found.")}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { event_type_id: eventTypeId, description_chars: parsed.description?.length ?? 0 },
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=1");
}

/**
 * Save the reschedule/cancel/reassign reason options (#346). Admin-only (guards
 * independently of the page gate). The editor posts the COMPLETE ordered set as a
 * JSON `payload`; parseReasonOptionsForm derives codes for new rows, forces locked
 * rows active, and re-injects any missing locked code. The write is a single keyed
 * upsert on (action, code), never a diff and never retire-by-absence, so it is
 * idempotent under retries and last-writer-wins per row (assume-it-runs-twice).
 */
export async function setReasonOptions(form: FormData): Promise<void> {
  const admin = await requireAdmin();

  let raw: unknown = {};
  try {
    raw = JSON.parse(String(form.get("payload") ?? "{}"));
  } catch {
    redirect(`/admin/settings/reasons?error=${encodeURIComponent("Could not read the submitted form.")}`);
  }

  const { rows, errors } = parseReasonOptionsForm(coerceReasonOptionsForm(raw));
  if (errors.length) {
    redirect(`/admin/settings/reasons?error=${encodeURIComponent([...new Set(errors)].join(" "))}`);
  }

  const now = new Date().toISOString();
  await supabaseAdmin()
    .from("reason_options")
    .upsert(
      rows.map((r) => ({ ...r, updated_at: now, updated_by: admin.id })),
      { onConflict: "action,code" },
    );

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "reason.options",
    details: { rows: rows.map((r) => ({ action: r.action, code: r.code, active: r.active })) },
  });
  revalidatePath("/admin/settings/reasons");
  redirect("/admin/settings/reasons?ok=1");
}

export async function setOrgDefaultHours(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`dday_${d}`));
  await supabaseAdmin()
    .from("organizations")
    .update({
      default_timezone: String(form.get("default_timezone") ?? "America/New_York"),
      // The fallbacks come from the seeded day (#1299), never a literal: a blank
      // field must not be able to write 09:00 back over the backfilled roster.
      default_start_minute: toMinutes(String(form.get("default_start") ?? SEED_START_TIME)),
      default_end_minute: toMinutes(
        roundUpToQuarterHour(String(form.get("default_end") ?? SEED_END_TIME)),
      ),
      default_weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    })
    .eq("id", admin.org_id);
  revalidatePath("/admin");
}

/** Applies the org default schedule to one agent (keeps their tz if already set). */
export async function useDefaultHours(form: FormData): Promise<void> {
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const actor = await requireManageAgent(userId, "agent.use_default_hours");

  const { data: org } = await db
    .from("organizations")
    .select(
      "default_timezone, default_start_minute, default_end_minute, default_weekdays",
    )
    .eq("id", actor.org_id)
    .single();
  const o = org as {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };

  // Applying the org default keeps the agent's own timezone if they have one,
  // else adopts the org default. Pass it back through upsertUserSchedule so the
  // single-row (user_id) unique index (#532) is honored without a check-then-
  // insert race.
  const { data: existing } = await db
    .from("availability_schedules")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const tz =
    (existing as { timezone: string } | null)?.timezone ?? o.default_timezone;
  const scheduleId = await upsertUserSchedule(userId, tz);

  await db.from("availability_rules").delete().eq("schedule_id", scheduleId);
  await db.from("availability_rules").insert(
    o.default_weekdays.map((weekday) => ({
      schedule_id: scheduleId,
      weekday,
      start_minute: o.default_start_minute,
      end_minute: o.default_end_minute,
    })),
  );
  revalidatePath("/admin");
}

export async function setBookable(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  await requireManageAgent(userId, "agent.bookable");
  // Same guarded path as the bookable-toggle API (#281/#912): making an agent
  // bookable when Slate can't reach their Google calendar is refused here too,
  // so the UI can't put a calendar-less agent into the pool. Deactivation
  // (bookable=false) is never gated.
  const result = await applyBookableByUserId(userId, form.get("bookable") === "true");
  if (result.status === "blocked") {
    throw new Error(
      result.reason === "google_unreachable"
        ? "Can't make this agent bookable: their Google calendar is unreachable (account gone from the Workspace, or delegation broken). Fix the calendar and try again."
        : "Couldn't verify this agent's Google calendar (a temporary Google issue). Please try again shortly.",
    );
  }
  revalidatePath("/admin");
}

/**
 * Manager+-only: deactivate or reactivate a user by hand (#278), the same
 * lifecycle the offboarding automation drives, so an admin can offboard or
 * rehire without invoking the API. `action` is "deactivate" | "reactivate".
 * Self-lockout guard: you cannot deactivate your own account (you'd lose access
 * immediately); reactivating yourself is moot since you couldn't reach this page
 * while deactivated. requireManageAgent enforces the manager+ / strict-outrank
 * escalation gate and writes the audit row.
 */
export async function setUserLifecycle(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  const action = String(form.get("action") ?? "");
  if (!userId || (action !== "deactivate" && action !== "reactivate")) return;
  const actor = await requireManager();
  if (action === "deactivate" && actor.id === userId) {
    throw new Error("You cannot deactivate your own account.");
  }
  await requireManageAgent(userId, action === "deactivate" ? "agent.deactivate" : "agent.reactivate");
  await applyLifecycleByUserId(userId, action);
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

/**
 * Admin+-only: start viewing the app as another user ranked below you. The cookie
 * only takes effect for a real admin+ session and only for a lower-ranked target
 * (resolveEffectiveUserId + canImpersonate gate it downstream), so it can't be
 * used to escalate. Lands on /me — the impersonated user's home.
 */
export async function startImpersonation(form: FormData): Promise<void> {
  const admin = await realCurrentUser();
  if (!admin || !atLeast(admin.role, "admin")) throw new Error("Not authorized");

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // #141: echo the typed email back on every failure so the form repopulates it
  // instead of wiping it (the field is uncontrolled and the redirect re-renders).
  if (!email) redirect(impersonationErrorUrl("Enter an email."));

  const { data } = await supabaseAdmin()
    .from("users")
    .select("id, role")
    .eq("org_id", admin.org_id)
    .eq("email", email)
    .maybeSingle();
  const target = data as { id: string; role: Role } | null;
  if (!target) {
    redirect(impersonationErrorUrl(`No user with email ${email}.`, email));
  }
  if (target.id === admin.id) {
    redirect(impersonationErrorUrl("That is already you.", email));
  }
  // Role ceiling (#588): can't view-as someone who outranks or equals you.
  if (!canImpersonate(admin.role, target.role)) {
    redirect(impersonationErrorUrl(`You can't impersonate a ${roleLabel(target.role)}.`, email));
  }

  const store = await cookies();
  // Timestamped value + matching maxAge so the session auto-expires (#653): the
  // server-side TTL check in resolveEffectiveUserId is authoritative, maxAge is
  // defense in depth.
  store.set(IMPERSONATE_COOKIE, encodeImpersonationCookie(target.id, Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IMPERSONATE_TTL_SECONDS,
  });
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "impersonate.start",
    targetUserId: target.id,
  });
  redirect("/me");
}

/** Stop impersonating and revert to your own session. Safe for anyone to call. */
export async function stopImpersonation(): Promise<void> {
  const real = await realCurrentUser();
  const store = await cookies();
  const targetId = impersonationTargetId(store.get(IMPERSONATE_COOKIE)?.value);
  store.delete(IMPERSONATE_COOKIE);
  if (real && targetId) {
    await recordAudit({
      orgId: real.org_id,
      actorId: real.id,
      action: "impersonate.stop",
      targetUserId: targetId,
    });
  }
  redirect("/admin");
}

/**
 * Clear a silently-dropped "view as" session (#652): the impersonated user became
 * ineligible mid-session (timed out, deactivated, removed, or promoted past the
 * ceiling), so the app already reverted the admin to themselves. The header fires
 * this in the background to delete the stale cookie and record the auto-end.
 *
 * Unlike stopImpersonation this does NOT redirect or revalidate: the admin is
 * already on their own view, and leaving the current render intact keeps the
 * "session ended" notice visible while the cookie clears behind it. Safe to call
 * repeatedly and when no cookie remains (idempotent).
 */
export async function endDroppedImpersonation(
  reason: "expired" | "unavailable",
): Promise<void> {
  const real = await realCurrentUser();
  const store = await cookies();
  const targetId = impersonationTargetId(store.get(IMPERSONATE_COOKIE)?.value);
  store.delete(IMPERSONATE_COOKIE);
  if (real && targetId) {
    await recordAudit({
      orgId: real.org_id,
      actorId: real.id,
      action: "impersonate.ended",
      targetUserId: targetId,
      details: { reason },
    });
  }
}

/** Assigns (or clears) an agent's manager, the routing edge for OOO requests. */
export async function setAgentManager(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const managerId = String(form.get("manager_id") ?? "");
  if (managerId === userId) throw new Error("An agent cannot manage themselves");

  if (managerId) {
    const { data } = await supabaseAdmin()
      .from("users")
      .select("role")
      .eq("id", managerId)
      .maybeSingle();
    const role = (data as { role: Role } | null)?.role;
    if (role !== "manager" && role !== "admin") {
      throw new Error("Manager must hold the manager or admin role");
    }
  }

  await requireManageAgent(userId, "agent.manager");
  await supabaseAdmin()
    .from("users")
    .update({ manager_id: managerId || null })
    .eq("id", userId);
  revalidatePath("/admin");
}

/** Admin-only: set the OOO Google calendar approval events land on (manager rows). */
export async function setOooCalendarId(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const calendarId = String(form.get("ooo_calendar_id") ?? "").trim();
  await supabaseAdmin()
    .from("users")
    .update({ ooo_calendar_id: calendarId || null })
    .eq("id", userId);
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "agent.ooo_calendar",
    targetUserId: userId,
    details: { ooo_calendar_id: calendarId || null },
  });
  revalidatePath("/admin");
}

/** Admin-only: change a user's tier (agent/manager/admin). Guards last-admin. */
export async function setUserRole(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  const next = String(form.get("role") ?? "");
  if (!userId || !isRole(next)) return;

  const { data: target } = await db
    .from("users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  const current = (target as { role: Role } | null)?.role;
  if (!current) return;

  // Only a super admin can grant or revoke super_admin; regular admins can't
  // mint a peer above themselves nor demote one.
  if (!canSetRole(admin.role, current, next)) {
    throw new Error("Not authorized to set this role");
  }

  // Block self-lockout: an admin can't strip their own org power and orphan
  // their /admin access (recovery would need a direct DB write).
  if (isSelfDemotion(admin.id === userId, current, next)) {
    throw new Error("You can't remove your own admin access");
  }

  // #1165: consult `error`. A failed count came back null, `?? 0` scored it as
  // "zero admins left", and the refusal then claimed "Cannot remove the last
  // admin", a fact the check never actually measured. Still refuse (fail closed
  // on the safe side), but say which of the two happened.
  const { count, error: countError } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .in("role", ["admin", "super_admin"]);
  if (countError) {
    log.error(
      "admin-actions",
      { msg: "admin count read failed", user_id: userId },
      countError,
    );
    throw new Error("The number of admins could not be verified, so the role was left unchanged");
  }
  if (!canChangeRole(current, next, count ?? 0)) {
    throw new Error("Cannot remove the last admin");
  }

  await db.from("users").update({ role: next }).eq("id", userId);
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "role.set",
    targetUserId: userId,
    details: { from: current, to: next },
  });
  revalidatePath("/admin");
}

// Server-side duplicate guard for the non-idempotent webhook re-delivery
// actions (#674). The SubmitButton's client-side disable (#630) can't stop a
// flaky-network retry (the client lost the response and retries AFTER the server
// already ran) or a racing request from re-firing a delivery. A DB-backed claim
// (acquireLock, sync_locks) that we DELIBERATELY DO NOT RELEASE makes a duplicate
// within the window a no-op: the claim lingers until its TTL expires, so it
// covers the retry-after-completion case, not just an in-flight race. A genuinely
// new action after the window still steals the stale claim and proceeds. `send()`
// records failure internally (never throws), so there is no error path that needs
// the claim released early.
const WEBHOOK_RESEND_DEDUPE_TTL_MS = 60_000;
const WEBHOOK_REPLAY_DEDUPE_TTL_MS = 5 * 60_000;

/** Admin-only: re-fire a webhook delivery from the delivery log. */
export async function resendWebhookDelivery(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const deliveryId = String(form.get("delivery_id") ?? "");
  if (!deliveryId) return;
  const claim = await acquireLock(
    `webhook_resend:${admin.org_id}:${deliveryId}`,
    WEBHOOK_RESEND_DEDUPE_TTL_MS,
  );
  // A duplicate or racing request already re-fired this delivery. Reported as the
  // deduped outcome rather than returning silently (#1076): from the admin's side a
  // second press that says nothing is indistinguishable from a broken button, and
  // the truthful thing to say is that the receiver already has it.
  if (!claim) {
    redirect(`/admin?resend=${encodeURIComponent("deduped")}`);
  }
  const result = await resendDelivery(deliveryId, admin.org_id);
  // #1073: a refused resend (payload erased for PII retention, suppressed, etc.)
  // must not look like a silent success. The reason goes to the server logs so it
  // is observable, AND to the admin (#1076), because logging it server side left
  // the person who pressed the button watching the log re-render unchanged.
  if (result !== "sent") {
    log.warn("webhook-resend", { msg: "resend not sent", delivery_id: deliveryId, result });
  }
  revalidatePath("/admin");
  redirect(`/admin?resend=${encodeURIComponent(result)}`);
}

/**
 * Admin-only: batch replay of dead-lettered deliveries after a receiver
 * outage (#33). Window is clamped to 1 hour - 7 days.
 */
export async function replayFailedWebhooks(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const hours = Math.min(Math.max(Number(form.get("hours")) || 24, 1), 168);
  // `hours` is in the key so a genuinely different window isn't deduped away,
  // while an identical resubmit (same window) is.
  const claim = await acquireLock(
    `webhook_replay:${admin.org_id}:${hours}`,
    WEBHOOK_REPLAY_DEDUPE_TTL_MS,
  );
  if (!claim) return; // a duplicate/racing request already replayed this window
  const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
  await replayDeadLetteredDeliveries(admin.org_id, sinceIso);
  revalidatePath("/admin");
}

export async function setAgentAttributes(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  await requireManageAgent(userId, "agent.attributes");

  const attributes: Attributes = {};
  // debt_team is multi-valued (comma-separated -> array).
  const debtTeam = String(form.get("debt_team") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (debtTeam.length) attributes.debt_team = debtTeam;

  const backend = String(form.get("backend_service") ?? "").trim();
  if (backend) attributes.backend_service = backend;
  const role = String(form.get("agent_role") ?? "").trim();
  if (role) attributes.role = role;
  const legal = String(form.get("legal_eligible") ?? "").trim();
  if (legal) attributes.legal_eligible = legal === "true";

  await supabaseAdmin()
    .from("users")
    .update({ attributes })
    .eq("id", userId);
  revalidatePath("/admin");
}

export async function setWebhookEndpoint(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const url = String(form.get("url") ?? "").trim();
  if (!url) return;
  // #1032: reject a non-https endpoint before storing it. Every booking event
  // (lead PII) and the Regal API key header would otherwise be POSTed in
  // plaintext on the first delivery. redirect() throws, so no write happens.
  const urlError = webhookUrlError(url);
  if (urlError) {
    redirect(`/admin?webhook_error=${encodeURIComponent(urlError)}`);
  }

  const format = form.get("format") === "regal" ? "regal" : "generic";
  // For Regal this is the API key sent as the Authorization header.
  //
  // #600: the form no longer round-trips the stored key to the browser, so a blank field
  // means "leave it alone", NOT "clear it". Writing null on blank meant an admin editing
  // the URL without retyping the key silently wiped it and took every booking event to
  // Regal offline. Omit the column entirely unless a new key was actually typed.
  const authHeader = String(form.get("auth_header") ?? "").trim() || null;

  const { data: existing } = await db
    .from("webhook_endpoints")
    .select("id")
    .eq("org_id", admin.org_id)
    .limit(1)
    .maybeSingle();

  if (existing) {
    await db
      .from("webhook_endpoints")
      .update(authHeader ? { url, format, auth_header: authHeader } : { url, format })
      .eq("id", (existing as { id: string }).id);
  } else {
    await db.from("webhook_endpoints").insert({
      org_id: admin.org_id,
      url,
      format,
      auth_header: authHeader,
      secret: nanoid(32),
    });
  }
  revalidatePath("/admin");
}

// Working-hours times snap down to a quarter hour (matches the 15-min pickers;
// safety net if an off-grid value slips through).
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h || 0) * 60 + (m || 0);
  return Math.floor(total / 15) * 15;
}


const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export type BusinessHoursFormState = {
  error: string | null;
  /**
   * Set when the save is being HELD for confirmation: the week is valid, but it
   * closes a day that already holds appointments. Re-submitting with `confirm_close`
   * goes through. Distinct from `error` because nothing is wrong; the person just
   * has to see the consequence first.
   */
  confirm?: { message: string } | null;
  ok?: boolean;
};

/**
 * Save the org's business hours (#1297).
 *
 * Returns state rather than redirecting so a refusal keeps the typed week on screen
 * (the same reason `submitMyOoo` does), which matters here because the form is
 * twenty-one fields and re-entering them after a bounce would be miserable.
 *
 * Two deliberate behaviours:
 *
 *  * CLOSING A DAY THAT HOLDS APPOINTMENTS WARNS, THEN SAVES. Per Dan's decision the
 *    existing appointments stand and nothing is moved automatically; the person is
 *    told how many there are and confirms. So the first submit comes back as
 *    `confirm`, and the second (carrying `confirm_close`) writes.
 *
 *  * NO MASS INVALIDATION. Unlike the booking-horizon save next door, this does NOT
 *    call `markAllBucketSlotsStale`. Gate 1 filters cached slots against the current
 *    hours at READ time (#1296), so a narrowing takes effect on the next request
 *    without touching a single row. Marking 60+ buckets stale would additionally risk
 *    a false `bucket_slots_stale` page, which is the finding that shaped #1296.
 */
export async function setBusinessHours(
  _prev: BusinessHoursFormState,
  form: FormData,
): Promise<BusinessHoursFormState> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const current = await loadBusinessHoursRows();
  const currentlyOpen = current.filter((r) => r.is_open).map((r) => r.weekday);

  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") raw[k] = v;

  const parsed = parseBusinessHoursForm(raw, { currentlyOpen });
  if (parsed.errors.length) return { error: parsed.errors.join(" ") };

  if (parsed.newlyClosed.length > 0 && !form.get("confirm_close")) {
    // Every future active booking, paged: bookings is a growth table, and a
    // truncated read would under-count and let someone close a day believing it
    // was empty. The count is taken in the org's zone (see countBookingsOnWeekdays).
    const nowIso = new Date().toISOString();
    const rows = await selectAllPages<{ starts_at: string }>(
      "business hours closure check",
      (from, to) =>
        db
          .from("bookings")
          .select("starts_at")
          .in("status", ["confirmed", "rescheduled"])
          .gte("starts_at", nowIso)
          .range(from, to),
    );
    const affected = countBookingsOnWeekdays(
      rows.map((r) => r.starts_at),
      BUSINESS_ZONE,
      parsed.newlyClosed,
    );
    if (affected > 0) {
      const days = parsed.newlyClosed.map((d) => DAY_NAMES[d]).join(" and ");
      const appts = affected === 1 ? "1 appointment" : `${affected} appointments`;
      return {
        error: null,
        confirm: {
          message: `Closing ${days} leaves ${appts} already booked. They stay in the diary and nobody is moved. Save again to close ${parsed.newlyClosed.length === 1 ? "the day" : "those days"} anyway.`,
        },
      };
    }
  }

  // Seven rows in one upsert, so the week can never be left half-saved.
  const { error } = await db
    .from("business_hours")
    .upsert(parsed.rows, { onConflict: "weekday" });
  if (error) return { error: `Could not save the hours: ${error.message}` };

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours",
    details: {
      week: parsed.rows.map((r) => ({
        weekday: r.weekday,
        is_open: r.is_open,
        start_minute: r.start_minute,
        end_minute: r.end_minute,
      })),
      newly_closed: parsed.newlyClosed,
    },
  });

  revalidatePath("/admin/settings");
  return { error: null, ok: true };
}
