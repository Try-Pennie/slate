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
  requireSuperAdmin,
} from "@/lib/auth";
import {
  isGrantableStaffRole,
  normalizeStaffEmail,
  planStaffAccess,
  requiresAdminCount,
  staffAccessInputError,
  type StaffAccessOutcome,
  type StaffAccessTarget,
} from "@/lib/admin/staff-access";
import { googleHostedDomain } from "@/lib/env";
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
import { unwrap } from "@/lib/db/result";
import { applyBookableByUserId } from "@/lib/bookable/service";
import { applyLifecycleByUserId } from "@/lib/offboarding/service";
import { syncSalesforceAgents, AGENTS_SYNC_STREAK_KEY } from "@/lib/salesforce/sync";
import { clearFailureStreak } from "@/lib/notify/streak";
import { replayDeadLetteredDeliveries, resendDelivery } from "@/lib/webhooks/emit";
import { webhookUrlError } from "@/lib/webhooks/url";
import { acquireLock } from "@/lib/locks";
import { recordAudit, type AuditAction } from "@/lib/audit";
import { impersonationErrorUrl } from "@/lib/admin/imp-error-url";
import { isActive } from "@/lib/active-user";
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
import { coverageForWeek } from "@/lib/booking/business-hours-coverage";
import { parseExceptionForm, countBookingsOnDate } from "@/lib/booking/business-hours-form";
import {
  loadCoverageAgents,
  currentWeekStartIso,
} from "@/lib/booking/business-hours-coverage-load";
import {
  COVERAGE_UNCHECKED_WARNING,
  newlyUncoveredGaps,
  newlyUncoveredWarning,
} from "@/lib/monitor/roster-coverage";
import { __clearChannelCache } from "@/lib/notify/channels";
import {
  planScheduleReplacement,
  planUniformSchedule,
  type ScheduleReplacementPlan,
  type ScheduleRule,
} from "@/lib/schedule-replacement";
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
  // #1629: this is an AUTHORIZATION read, and swallowing it failed OPEN. A null
  // `data` defaulted the target to "agent", which is the role a manager is allowed
  // to edit, so an unreadable users row let a manager edit an admin. `unwrap`
  // refuses instead of guessing the answer that grants the most.
  const data = unwrap(
    await supabaseAdmin().from("users").select("role").eq("id", userId).maybeSingle(),
    "manage-agent target role",
  );
  // #1046: and a read that finds NOTHING must refuse too. The `?? "agent"` this
  // replaces defaulted an absent target to the one role every manager may edit, so
  // a stale or mistyped id passed the escalation guard and recorded an audit row
  // against a user that does not exist. Absent is not a role; it is a refusal.
  const target = data as { role: Role } | null;
  if (!target) throw new Error("Not authorized");
  const targetRole = target.role;
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
  /**
   * The plan, already validated by the caller through `planScheduleReplacement`
   * (a window PER DAY, #1308) or `planUniformSchedule` (one window on several
   * days, which is what the org default and the "use company hours" button mean).
   * Taking the PLAN rather than raw days is what puts every writer on one
   * validator: the org-default button used to bypass it entirely (#1670).
   */
  plan: ScheduleReplacementPlan,
): Promise<void> {
  if (!plan.ok) throw new Error(plan.error);

  const db = supabaseAdmin();
  // The VALIDATED zone, never the raw argument: an unreadable one makes every
  // weekday comparison in `isWithinWorkingHours` false, so the agent is bookable
  // at no time at all while the form still renders their hours (#1671).
  const scheduleId = await upsertUserSchedule(userId, plan.timezone);
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
  // #1629: both reads decide what gets WRITTEN to the agent's schedule. The org
  // read swallowed into a null then threw an unattributable TypeError on the very
  // next line; `unwrap` names the read that failed instead.
  const org = unwrap(
    await db
      .from("organizations")
      .select(
        "default_timezone, default_start_minute, default_end_minute, default_weekdays",
      )
      .eq("id", orgId)
      .single(),
    "org default schedule",
  );
  const o = org as {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };
  // An unreadable schedule read as "this agent has no timezone of their own" and
  // the write below then REPLACED their real one with the org default. A silent
  // timezone change moves every hour they are bookable.
  const existing = unwrap(
    await db.from("availability_schedules").select("timezone").eq("user_id", userId).maybeSingle(),
    "agent schedule timezone",
  );
  const tz =
    (existing as { timezone: string } | null)?.timezone ?? o.default_timezone;
  // The org default IS one window on several days, which is exactly what
  // `planUniformSchedule` is for: put this agent back on the company's hours.
  await replaceUserSchedule(
    userId,
    planUniformSchedule(
      o.default_weekdays,
      o.default_start_minute,
      o.default_end_minute,
      tz,
    ),
  );
}

/**
 * The week as the per-day hours form submits it (#1308): a checkbox and its own
 * pair of times per weekday.
 *
 * A day that is not ticked contributes nothing, so its times are never read and a
 * blank pair on an unticked day cannot refuse the save. A TICKED day whose times
 * are unreadable is passed through as NaN deliberately, so `planScheduleReplacement`
 * refuses it and names the day, rather than a permissive default here quietly
 * moving somebody to midnight (L50).
 */
const perDayFrom = (form: FormData): ScheduleRule[] =>
  [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`day_${d}`)).flatMap((weekday) => {
    // Repeated field names, paired by position (#1764). A single `start_1` can no
    // longer identify a window now that a day can hold several, and repeated names
    // survive a middle row being removed with no index bookkeeping to get wrong.
    const starts = form.getAll(`start_${weekday}`).map(String);
    const ends = form.getAll(`end_${weekday}`).map(String);
    const count = Math.max(starts.length, ends.length);

    const windows: ScheduleRule[] = [];
    let blanks = 0;
    for (let i = 0; i < count; i++) {
      const start = starts[i] ?? "";
      const end = ends[i] ?? "";
      // A window with NEITHER bound is a row somebody added and left alone, which
      // must not refuse a save. A HALF filled one is a mistake and is passed
      // through as NaN so the planner refuses it and names the day: dropping it
      // would save a week quietly missing hours that had just been entered.
      if (start.trim() === "" && end.trim() === "") {
        blanks++;
        continue;
      }
      windows.push({
        weekday,
        start_minute: toMinutes(start),
        end_minute: toMinutes(roundUpToQuarterHour(end)),
      });
    }

    // A ticked day that contributed nothing (every window blank, or no window
    // fields at all) is NOT silently dropped. Dropping it would either shorten the
    // week without saying so or, if it were the only day, produce the "pick at
    // least one day" refusal for a day that was in fact picked. One unreadable
    // window instead, so the refusal names this day (L11).
    if (windows.length === 0 && (blanks > 0 || count === 0)) {
      return [{ weekday, start_minute: Number.NaN, end_minute: Number.NaN }];
    }
    return windows;
  });

/** Agent self-service: set my own working hours. */
export async function setMyWorkingHours(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) return;
  await replaceUserSchedule(
    me.id,
    planScheduleReplacement(
      perDayFrom(form),
      String(form.get("timezone") ?? "America/New_York"),
    ),
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
      // Reported, because a run that CLEARS a link changes who approves someone's
      // time off just as much as one that sets it, and a summary that only ever
      // counts additions makes convergence look like a quiet run (#1474).
      r.managersUnlinked
        ? `${plural(r.managersUnlinked, "agent")} no longer has a manager in Salesforce`
        : null,
      // The two refusals, said separately (#1653). Before the split, one line
      // covered both, so an admin who pressed sync to fix a manager problem read
      // "could not be matched" whether the name was missing (a picklist value to
      // correct) or shared by two people (a Salesforce record to fix), and the
      // second is the one that decides whether an approval reaches the right
      // person. The unit is AGENTS, which is what the count has always held: the
      // old line said "manager name" and rendered "15 manager names" for one
      // unmatched name shared by a team of fifteen.
      r.managersUnresolved
        ? `${plural(r.managersUnresolved, "agent")} ${r.managersUnresolved === 1 ? "has" : "have"} a manager name nothing in Salesforce matched, so those links were left alone`
        : null,
      r.managersAmbiguous
        ? `${plural(r.managersAmbiguous, "agent")} left unlinked because ${plural(r.managerNamesAmbiguous, "manager name")} in Salesforce ${r.managerNamesAmbiguous === 1 ? "answers" : "answer"} to more than one user`
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

/**
 * Replace a bucket's manual members, atomically (#1930).
 *
 * It was a delete then an insert, as two statements, binding NEITHER error. So a
 * failed insert, or an isolate evicted between them, left the bucket with no
 * manual members while this returned normally and the page redrew as saved. A
 * routing pool with nobody in it turns every matching lead away.
 *
 * Through the migration 0114 function, which commits or rolls back as a whole,
 * exactly as `replaceUserSchedule` does since #1293. Ordering in application code
 * cannot close that window.
 *
 * Success is claimed on the COUNT the database reports, never on the absence of
 * an error, because a replace that landed a different number of members than
 * asked for is a silently wrong pool and this is the last place that can tell.
 * The count is compared against the DEDUPLICATED input, since the function
 * inserts `distinct` (the form can post one id twice when a membership is both
 * matched from the roster and carried over as an off roster id, #1762) and
 * comparing against the raw length would fail every such save.
 */
async function replaceBucketMembers(
  bucketId: string,
  memberIds: string[],
): Promise<void> {
  const expected = new Set(memberIds).size;
  const { data, error } = await supabaseAdmin().rpc("replace_bucket_members", {
    p_bucket_id: bucketId,
    p_user_ids: memberIds,
  });
  if (error) {
    throw new Error(`The bucket's members could not be saved: ${error.message}`);
  }
  const written = typeof data === "number" ? data : Number.NaN;
  if (written !== expected) {
    throw new Error(
      `The bucket's members could not be saved: expected ${expected}, the database recorded ` +
        `${Number.isFinite(written) ? written : "an unreadable count"}.`,
    );
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

  // #1930: the insert's error was bound and then ignored, so a duplicate XBC
  // against the `(org_id, code)` unique index (the index the seeder upserts on)
  // was indistinguishable from a successful create. It refuses by NAME now, since
  // "that code already has a bucket" and "the database is unreachable" send a
  // person to different places (L11).
  if (error) {
    throw new Error(
      error.code === "23505"
        ? `A bucket with code ${String(form.get("code") ?? "").trim()} already exists.`
        : `The bucket could not be created: ${error.message}`,
    );
  }
  const created = bucket as { id: string } | null;
  if (!created) {
    throw new Error("The bucket could not be created: the database returned no row.");
  }
  if (memberIds.length) {
    await replaceBucketMembers(created.id, memberIds);
  }
  // #1932: editing where leads get SENT was the one privileged action absent from
  // the trail. Recorded AFTER the writes, so it reflects what actually happened.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "bucket.created",
    details: {
      bucket_id: created.id,
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      members_added: [...new Set(memberIds)],
    },
  });
  revalidatePath("/admin/buckets");
}

export async function updateBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(form.get("bucket_id") ?? "");
  if (!id) return;
  const db = supabaseAdmin();

  // #1932: the state BEFORE the write, so the trail can answer the question an
  // audit exists to answer, which is what the configuration was at a given
  // moment. An entry naming only the bucket can never answer it (L529). Read
  // through `unwrap`, because merging over a failed read would record the change
  // as though nothing had been there.
  const before = unwrap(
    await db
      .from("buckets")
      .select("code, name, event_type_id, criteria, routing_form_id, fallback_user_id")
      .eq("id", id)
      .maybeSingle(),
    "bucket before update",
  ) as Record<string, unknown> | null;
  const membersBefore = (
    unwrap(
      await db.from("bucket_members").select("user_id").eq("bucket_id", id),
      "bucket members before update",
    ) ?? []
  ).map((m) => (m as { user_id: string }).user_id);

  const after = {
    code: String(form.get("code") ?? "").trim(),
    name: String(form.get("name") ?? "").trim(),
    event_type_id: String(form.get("event_type_id") ?? ""),
    criteria: criteriaFromForm(form),
    routing_form_id: String(form.get("routing_form_id") ?? "").trim() || null,
    fallback_user_id: String(form.get("fallback_user_id") ?? "") || null,
  };

  // #1930: the error was discarded, so a refused update still ran the membership
  // replace and redrew as saved. It throws now, and it throws BEFORE the members
  // are touched, so a refused bucket edit cannot half apply.
  const { error } = await db.from("buckets").update(after).eq("id", id);
  if (error) {
    throw new Error(
      error.code === "23505"
        ? `A bucket with code ${after.code} already exists.`
        : `The bucket could not be saved: ${error.message}`,
    );
  }

  const memberIds = form.getAll("members").map(String).filter(Boolean);
  await replaceBucketMembers(id, memberIds);

  const membersAfter = [...new Set(memberIds)];
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "bucket.updated",
    details: {
      bucket_id: id,
      code: after.code,
      // Only what CHANGED, with both values, so a reader is not left comparing
      // two full objects to find the one field that moved.
      changed: Object.fromEntries(
        Object.entries(after).filter(([k, v]) =>
          JSON.stringify(before?.[k] ?? null) !== JSON.stringify(v ?? null),
        ).map(([k, v]) => [k, { from: before?.[k] ?? null, to: v }]),
      ),
      members_added: membersAfter.filter((m) => !membersBefore.includes(m)),
      members_removed: membersBefore.filter((m) => !membersAfter.includes(m)),
    },
  });
  revalidatePath("/admin/buckets");
}

export async function setWorkingHours(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  await requireManageAgent(userId, "agent.hours");
  const timezone = String(form.get("timezone") ?? "America/New_York");

  // One schedule per user (enforced by the availability_schedules(user_id)
  // unique index, #532): replaceUserSchedule upserts it, then replaces its rules.
  await replaceUserSchedule(userId, planScheduleReplacement(perDayFrom(form), timezone));
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
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
    redirect(`/admin/alerts?error=${encodeURIComponent(parsed.errors.join(" "))}`);
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
  revalidatePath("/admin/alerts");
  redirect("/admin/alerts?ok=1");
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
  // #1629: an empty valid set makes EVERY code invalid, so a failed read told the
  // admin their real bucket code does not exist. That is fail-closed, but with a
  // false reason, which sends them hunting for a typo that is not there (L11).
  const buckets = unwrap(
    await db.from("buckets").select("code, is_test").eq("is_test", false),
    "default bucket valid codes",
  );
  const validCodes = new Set(((buckets ?? []) as { code: string }[]).map((b) => b.code));

  const parsed = parseDefaultBucketForm(String(form.get("default_bucket_code") ?? ""), validCodes);
  if (parsed.errors.length) {
    redirect(`/admin/buckets?error=${encodeURIComponent(parsed.errors.join(" "))}`);
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
  revalidatePath("/admin/buckets");
  redirect("/admin/buckets?ok=1");
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
    redirect(`/admin/business-hours?error=${encodeURIComponent(parsed.errors.join(" "))}`);
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
  revalidatePath("/admin/business-hours");
  redirect("/admin/business-hours?ok=1");
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
    redirect(`/admin/booker-copy?error=${encodeURIComponent("No event type was named.")}`);
  }

  const parsed = parseEventDescriptionForm(String(form.get("description") ?? ""));
  if (parsed.errors.length) {
    redirect(`/admin/booker-copy?error=${encodeURIComponent(parsed.errors.join(" "))}`);
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
      `/admin/booker-copy?error=${encodeURIComponent("Could not save the description. Please try again.")}`,
    );
  }
  // Zero rows is not a success either: the id did not match anything this admin's
  // org owns, so nothing changed and saying otherwise would be a lie about somebody
  // else's data as much as about theirs.
  if (saved.count === 0) {
    redirect(
      `/admin/booker-copy?error=${encodeURIComponent("That event type was not found.")}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { event_type_id: eventTypeId, description_chars: parsed.description?.length ?? 0 },
  });
  revalidatePath("/admin/booker-copy");
  redirect("/admin/booker-copy?ok=1");
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
    redirect(`/admin/booking-reasons?error=${encodeURIComponent("Could not read the submitted form.")}`);
  }

  const { rows, errors } = parseReasonOptionsForm(coerceReasonOptionsForm(raw));
  if (errors.length) {
    redirect(`/admin/booking-reasons?error=${encodeURIComponent([...new Set(errors)].join(" "))}`);
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
  revalidatePath("/admin/booking-reasons");
  redirect("/admin/booking-reasons?ok=1");
}

export async function setOrgDefaultHours(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`dday_${d}`));
  // #1671: validated before it is stored, because this value is what an agent
  // with no zone of their own ADOPTS, so an unreadable one here makes every new
  // agent bookable at no time at all. `planUniformSchedule` is the same validator
  // the per-agent writes use, so the two can never disagree about what a
  // storable week is.
  const defaultTimezone = String(form.get("default_timezone") ?? "America/New_York");
  const defaults = planUniformSchedule(
    weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    readableMinutes(String(form.get("default_start") ?? ""), SEED_START_TIME),
    readableMinutes(roundUpToQuarterHour(String(form.get("default_end") ?? "")), SEED_END_TIME),
    defaultTimezone,
  );
  if (!defaults.ok) throw new Error(defaults.error);

  await supabaseAdmin()
    .from("organizations")
    .update({
      default_timezone: defaultTimezone,
      // The fallbacks come from the seeded day (#1299), never a literal: a blank
      // field must not be able to write 09:00 back over the backfilled roster.
      // An unreadable time falls back to the SEEDED day rather than to midnight
      // (L50): a blank or malformed field must not be able to write a window
      // nobody chose over the backfilled roster's starting hours.
      default_start_minute: readableMinutes(
        String(form.get("default_start") ?? ""),
        SEED_START_TIME,
      ),
      default_end_minute: readableMinutes(
        roundUpToQuarterHour(String(form.get("default_end") ?? "")),
        SEED_END_TIME,
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

  // #1629: same pair as applyOrgDefaultToUser above, same reasoning. Both reads
  // decide what is written to the agent's schedule, so neither may be guessed.
  const org = unwrap(
    await db
      .from("organizations")
      .select(
        "default_timezone, default_start_minute, default_end_minute, default_weekdays",
      )
      .eq("id", actor.org_id)
      .single(),
    "org default schedule",
  );
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
  const existing = unwrap(
    await db.from("availability_schedules").select("timezone").eq("user_id", userId).maybeSingle(),
    "agent schedule timezone",
  );
  const tz =
    (existing as { timezone: string } | null)?.timezone ?? o.default_timezone;

  // #1670: through `replaceUserSchedule`, like every other writer on this path.
  // This button used to be the straggler: a bare delete then insert, with neither
  // `error` bound, no transaction and no validation. If the insert errored, or the
  // isolate died between the two statements, the action still reported success and
  // left the agent with a schedule row holding NO rules, which makes
  // `isWithinWorkingHours` reject every instant, so that agent offers no times,
  // permanently. Two things hid it: the reloaded page draws
  // `workingHoursDays(rules, org.default_weekdays)`, so zero rules renders as the
  // org default week the admin just asked for, and the #838 coverage monitor looks
  // for agents with no availability_schedules ROW, which a row with no rules is
  // not. `planUniformSchedule`, whose own docstring says it is what this button
  // means, had no callers at all.
  await replaceUserSchedule(
    userId,
    planUniformSchedule(
      o.default_weekdays,
      o.default_start_minute,
      o.default_end_minute,
      tz,
    ),
  );
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

export async function setBookable(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  await requireManageAgent(userId, "agent.bookable");
  const wantBookable = form.get("bookable") === "true";
  // Same guarded path as the bookable-toggle API (#281/#912): making an agent
  // bookable when Slate can't reach their Google calendar is refused here too,
  // so the UI can't put a calendar-less agent into the pool. Deactivation
  // (bookable=false) is never gated.
  const result = await applyBookableByUserId(userId, wantBookable);

  /**
   * The page this form is on, and it comes back saying what happened (#1769).
   *
   * It used to `revalidatePath("/admin")`, which names the Overview page rather
   * than the agent page the form is on, and return void. So the only thing that
   * changed on screen was one button being replaced by another in the corner of a
   * dense row, which is not a confirmation, it is a difference you would have to
   * already be looking for. The refusal was worse: it threw, there is no error
   * boundary on this route, and Next scrubs a server error's message in
   * production, so the most useful sentence in this action reached nobody.
   *
   * A fixed CODE rather than the sentence, for two reasons: the copy stays in the
   * page where the preview and the copy lint can see it, and nothing an admin can
   * type reaches the banner. The agent is not named because they are the subject of
   * the page this lands on, and a name or an email in a query string is a person's
   * identity in browser history for no gain.
   */
  const back = `/admin/agents/${userId}`;
  revalidatePath(back);
  if (result.status === "blocked") {
    // Nothing was written: the gate refused before the update.
    redirect(
      `${back}?bookable=${result.reason === "google_unreachable" ? "blocked-gone" : "blocked-transient"}`,
    );
    return;
  }
  if (result.status === "not_found") {
    redirect(`${back}?bookable=missing`);
    return;
  }
  redirect(`${back}?bookable=${wantBookable ? "on" : "off"}`);
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
 *
 * OFFBOARDED TARGETS ARE REFUSED HERE (#1795), and not because the cookie would
 * otherwise work: `resolveImpersonationState` filters the target on
 * `deactivated_at` and has always refused a departed user. The defect was what
 * happened instead. The cookie was set, an `impersonate.start` audit row was
 * written, and the very next request found the target ineligible and reverted the
 * admin to themselves, so the audit log recorded a session that never existed and
 * the admin got a silent round trip. Two distinct causes were sharing one
 * outcome (L11), and the fix is to give this one its own refusal before anything
 * is written.
 */
export async function startImpersonation(form: FormData): Promise<void> {
  const admin = await realCurrentUser();
  if (!admin || !atLeast(admin.role, "admin")) throw new Error("Not authorized");

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Every remaining caller is a per row control submitting that row's own address
  // in a hidden field (#1749), so an empty email is a malformed call rather than a
  // typo. It still refuses rather than looking up the empty string.
  if (!email) redirect(impersonationErrorUrl("No address was submitted."));

  // #1629: a null on error took the "No user with email X." branch, which tells an
  // admin the person does not exist when the read simply failed. The next thing
  // somebody does with that answer is create the account again.
  const data = unwrap(
    await supabaseAdmin()
      .from("users")
      .select("id, role, deactivated_at")
      .eq("org_id", admin.org_id)
      .eq("email", email)
      .maybeSingle(),
    "impersonation target lookup",
  );
  const target = data as { id: string; role: Role; deactivated_at: string | null } | null;
  if (!target) {
    redirect(impersonationErrorUrl(`No user with email ${email}.`));
  }
  if (target.id === admin.id) {
    redirect(impersonationErrorUrl("That is already you."));
  }
  // #1795: a departed employee. Refused before the cookie and before the audit
  // row, since downstream would drop the session on the next request anyway and
  // the only trace left would be an audit entry for something that never ran.
  if (!isActive(target)) {
    redirect(impersonationErrorUrl(`${email} has been offboarded.`));
  }
  // Role ceiling (#588): can't view-as someone who outranks or equals you.
  if (!canImpersonate(admin.role, target.role)) {
    redirect(impersonationErrorUrl(`You can't impersonate a ${roleLabel(target.role)}.`));
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
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

/** Admin-only: change a user's tier (agent/manager/admin). Guards last-admin. */
export async function setUserRole(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  const next = String(form.get("role") ?? "");
  if (!userId || !isRole(next)) return;

  // #1629: an unreadable row made `current` undefined and this returned SILENTLY,
  // so the admin pressed "set role", the page re-rendered unchanged, and nothing
  // anywhere said why. The read also feeds `canSetRole`, so guessing it is a
  // guess at an authorization input.
  const target = unwrap(
    await db.from("users").select("role").eq("id", userId).maybeSingle(),
    "set-role target role",
  );
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
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

/**
 * Super admin only: give a staff member elevated access by email (#160).
 *
 * These people are not in the Salesforce agent feed, so nothing creates them.
 * Until now that meant a developer editing the users table by hand, which is why
 * four admins were seeded that way in one session, and it carried a silent
 * failure: `provisionUser` matches a login to a row BY EMAIL, so a row keyed to
 * an address that is not the person's real Google login is never used and nothing
 * anywhere reports it.
 *
 * The guards, all server side and none of them relying on the button being hidden:
 *
 *  - **Who may call it.** `requireSuperAdmin`, the highest role, at the top of the
 *    action. `planStaffAccess` asks the same question again from its own module,
 *    so a second entry point wired to a weaker guard still could not grant.
 *  - **What may be granted.** The same `canSetRole` the per user role editor runs,
 *    over a narrower set of roles: `super_admin` is never minted from a typed
 *    address, and `agent` is not a grant.
 *  - **Whose data it touches.** Everything is scoped to the caller's org: the row
 *    is created in it, an address already held by another org is refused by name,
 *    and the admin count is counted within it.
 *  - **The last admin.** Typing a current admin's address and picking a lower role
 *    is a demotion by another name, so it carries the same invariant. A count that
 *    could not be READ is not a count (#1165): it refuses in its own words rather
 *    than being scored as zero and producing a confident claim about a roster
 *    nothing measured, and it is only read where it actually decides something, so
 *    a broken read cannot block a grant that never depended on it.
 *
 * Every ending, refusal and success alike, comes back on the page as its own
 * sentence rather than as an error boundary, because the person needs to read the
 * address back: it is the address, not the button, that decides whether this works.
 */
export async function grantStaffAccess(form: FormData): Promise<void> {
  const actor = await requireSuperAdmin();
  const email = normalizeStaffEmail(String(form.get("email") ?? ""));
  const requestedRole = String(form.get("role") ?? "");
  const allowedDomain = googleHostedDomain();

  // Annotated rather than inferred: TypeScript only treats a call as ending
  // control flow when the callee carries an explicit `never` TYPE, and without
  // that every `done()` below reads as a fall through.
  const done: (outcome: StaffAccessOutcome) => never = (outcome) => {
    revalidatePath("/admin");
    redirect(
      `/admin?staff=${outcome}&staff_email=${encodeURIComponent(email)}` +
        `&staff_role=${encodeURIComponent(requestedRole)}#team-access`,
    );
  };

  // Judged before any database read, so a caller who may not do this at all, or an
  // address that could never sign in, never reaches the roster.
  const inputError = staffAccessInputError({
    actorRole: actor.role,
    email,
    requestedRole,
    allowedDomain,
  });
  // The second half is a narrowing for `tsc`, not a second policy: it can only be
  // reached when `staffAccessInputError` already returned `invalid_role`.
  if (inputError || !isGrantableStaffRole(requestedRole)) done(inputError ?? "invalid_role");

  const db = supabaseAdmin();
  // Not org scoped on purpose: `users.email` is globally unique, so an address
  // held by another org has to be FOUND in order to be refused by name. The plan
  // then compares the org. An unreadable lookup is not an absent row, so it stops
  // here rather than falling through to the create path.
  const { data: existingRow, error: lookupError } = await db
    .from("users")
    .select("id, org_id, role, deactivated_at, auth_user_id")
    .eq("email", email)
    .maybeSingle();
  if (lookupError) {
    log.error("admin-actions", { msg: "staff access lookup failed" }, lookupError);
    done("lookup_failed");
  }
  const existing = (existingRow as StaffAccessTarget | null) ?? null;

  let adminCount: number | null = null;
  if (existing && requiresAdminCount(existing.role, requestedRole)) {
    const { count, error: countError } = await db
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("org_id", actor.org_id)
      .in("role", ["admin", "super_admin"]);
    if (countError) {
      log.error("admin-actions", { msg: "admin count read failed" }, countError);
    }
    adminCount = countError ? null : (count ?? 0);
  }

  const plan = planStaffAccess({
    actorRole: actor.role,
    actorId: actor.id,
    actorOrgId: actor.org_id,
    allowedDomain,
    email,
    requestedRole,
    existing,
    adminCount,
  });
  if (!plan.ok) done(plan.outcome);

  if (plan.outcome === "granted") {
    const { error } = await db.from("users").insert({
      org_id: actor.org_id,
      email: plan.email,
      role: plan.role,
      // Never bookable on arrival, for the same reason `provisionUser` says so at
      // its own insert (#1266): adding an account must not put anyone into the
      // round robin pool. A staff member added here is not an agent at all.
      bookable: false,
    });
    if (error) {
      log.error("admin-actions", { msg: "staff access insert failed" }, error);
      done("write_failed");
    }
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "staff.access_granted",
      details: { email: plan.email, role: plan.role },
    });
  } else if (plan.outcome === "updated") {
    const { error } = await db
      .from("users")
      .update({ role: plan.role })
      .eq("id", plan.userId);
    if (error) {
      log.error("admin-actions", { msg: "staff access update failed" }, error);
      done("write_failed");
    }
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "role.set",
      targetUserId: plan.userId,
      details: { from: plan.from, to: plan.role, via: "team_access" },
    });
  }

  done(plan.outcome);
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

/**
 * The one routing attribute Slate owns (#1874).
 *
 * `debt_team`, `backend_service` and `role` are Salesforce's
 * (`SF_MANAGED_KEYS`): the hourly roster sync deletes and rewrites all three, so
 * anything set here was undone within the hour. The panel offering them as free
 * text was therefore a typo waiting to happen AND an override that silently
 * reverted, and both are gone: those three are read only now, and this action
 * writes exactly one key.
 *
 * `legal_eligible` stays, because routing really does match on it
 * (`legal_eligible!` in the XBC criteria) and nothing else writes it.
 */
export async function setAgentAttributes(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  await requireManageAgent(userId, "agent.attributes");
  const db = supabaseAdmin();

  // #1874: MERGED over what is stored, never rebuilt from the form.
  //
  // This wrote `update({ attributes })` with an object built only from the form
  // fields, which was correct only while the form carried every key. The moment
  // it stopped carrying the three Salesforce ones, that same statement would have
  // deleted an agent's debt teams on every legal eligible save, taking them out
  // of every bucket until the next sync put them back (L510).
  //
  // The read throws rather than defaulting: an unreadable row here would merge
  // over `{}`, which is the same wipe by a different route, and an empty
  // attributes object is a legitimate value so nothing downstream could tell.
  const existing = unwrap(
    await db.from("users").select("attributes").eq("id", userId).maybeSingle(),
    "agent attributes",
  ) as { attributes: Attributes | null } | null;

  const attributes: Attributes = { ...(existing?.attributes ?? {}) };
  const legal = String(form.get("legal_eligible") ?? "").trim();
  // "" is the "Not set" option, and it has to REMOVE the key rather than skip
  // it: with a merge, skipping would make clearing the field impossible, and
  // `legal_eligible!` treats an unset agent differently from a false one.
  if (legal === "true" || legal === "false") attributes.legal_eligible = legal === "true";
  else delete attributes.legal_eligible;

  await db
    .from("users")
    .update({ attributes })
    .eq("id", userId);
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
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

  // #1629: this null decides UPDATE versus INSERT. On a read error it read as "no
  // endpoint exists" and took the insert branch, adding a SECOND endpoint row for
  // the org: every booking event then delivered twice, and the page's own
  // `.limit(1)` read would afterwards show whichever row came back first.
  const existing = unwrap(
    await db
      .from("webhook_endpoints")
      .select("id")
      .eq("org_id", admin.org_id)
      .limit(1)
      .maybeSingle(),
    "webhook endpoint upsert lookup",
  );

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

/**
 * Working-hours times snap down to a quarter hour (matching the 15 minute pickers;
 * a safety net if an off-grid value slips through).
 *
 * An UNREADABLE time returns NaN, deliberately, and every caller has to map that to
 * a refusal. It used to coalesce a missing hour to zero, so "not a time" and a blank
 * field both became MIDNIGHT and were saved as a real window: the agent's day
 * silently started at 00:00 and the form reported success (L50). Midnight is a
 * perfectly valid time, so nothing downstream could tell the difference.
 */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return Math.floor((h * 60 + m) / 15) * 15;
}


/** `toMinutes`, with a named fallback for the one caller whose field is optional. */
function readableMinutes(hhmm: string, fallback: string): number {
  const parsed = toMinutes(hhmm);
  return Number.isFinite(parsed) ? parsed : toMinutes(fallback);
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
  /**
   * Set on a SAVE THAT WENT THROUGH which opened hours no bookable agent covers
   * (#1458). A warning, never a refusal: opening hours ahead of rostering them is
   * a legitimate order of operations, so this says what will happen rather than
   * standing in the way (L54). The roster alarm still notices it later; this
   * reaches the person who caused it, while they are looking at the screen.
   */
  warning?: string | null;
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
/**
 * Add or replace a date the org is shut (or open), whatever the weekly pattern
 * says (#1363).
 *
 * The confirmation mirrors the weekly editor's, and Dan's decision behind it
 * (#1297): closing a date that already holds appointments WARNS with a count and
 * then saves anyway. Existing appointments stand and nothing moves automatically,
 * because a closure is about what we OFFER from now on, and silently cancelling
 * somebody's call would be a far larger action than the one being taken.
 */
export async function setBusinessHoursException(
  _prev: BusinessHoursFormState,
  form: FormData,
): Promise<BusinessHoursFormState> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") raw[k] = v;

  const parsed = parseExceptionForm(raw);
  if (parsed.errors.length || !parsed.row) return { error: parsed.errors.join(" ") };
  const row = parsed.row;

  if (!row.is_open && !form.get("confirm_close")) {
    // Every future active booking, paged: bookings is a growth table, and a
    // truncated read would under-count and let someone close a date believing it
    // was empty.
    const nowIso = new Date().toISOString();
    const rows = await selectAllPages<{ starts_at: string }>(
      "business hours exception closure check",
      (from, to) =>
        db
          .from("bookings")
          .select("starts_at")
          .in("status", ["confirmed", "rescheduled"])
          .gte("starts_at", nowIso)
          .range(from, to),
    );
    const affected = countBookingsOnDate(rows.map((r) => r.starts_at), BUSINESS_ZONE, row.on_date);
    if (affected > 0) {
      const appts = affected === 1 ? "1 appointment" : `${affected} appointments`;
      return {
        error: null,
        confirm: {
          message: `Closing ${row.on_date} leaves ${appts} already booked. They stay in the diary and nobody is moved. Save again to close that date anyway.`,
        },
      };
    }
  }

  const { error } = await db
    .from("business_hours_exceptions")
    .upsert(
      { ...row, updated_at: new Date().toISOString(), updated_by: admin.id },
      { onConflict: "on_date" },
    );
  if (error) return { error: `Could not save that date: ${error.message}` };

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours_exception",
    details: { on_date: row.on_date, is_open: row.is_open, note: row.note },
  });
  revalidatePath("/admin/business-hours");
  return { error: null, ok: true };
}

/** Drop a date exception, so that date goes back to following the weekly pattern. */
export async function removeBusinessHoursException(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const on_date = String(form.get("on_date") ?? "").trim();
  if (!on_date) return;
  const { error } = await supabaseAdmin()
    .from("business_hours_exceptions")
    .delete()
    .eq("on_date", on_date);
  if (error) {
    // Loud rather than a silent no-op: the admin would otherwise see the date
    // vanish from the list on the next render and reappear on the one after.
    log.error("business-hours", { msg: "could not remove date exception", on_date }, error);
    return;
  }
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours_exception_removed",
    details: { on_date },
  });
  revalidatePath("/admin/business-hours");
}

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

  revalidatePath("/admin/business-hours");

  // #1458: measured AFTER the write, so it can only ever describe hours that are
  // really saved. Wrapped, because a coverage read that fails must not turn a
  // successful save into an error the admin will try to repeat.
  let warning: string | null = null;
  try {
    const agents = await loadCoverageAgents(db);
    const weekStartIso = currentWeekStartIso();
    const readout = (rows: typeof current) =>
      coverageForWeek({ businessHours: rows, zone: BUSINESS_ZONE, agents, weekStartIso });
    const added = newlyUncoveredGaps(readout(current), readout(parsed.rows));
    // Null is "could not check", which is a different thing from "nothing added"
    // and must not render as silence (L11).
    if (added === null) warning = COVERAGE_UNCHECKED_WARNING;
    else if (added.length > 0) warning = newlyUncoveredWarning(added);
  } catch (err) {
    log.warn("business-hours", { msg: "coverage check after save failed" }, err);
    warning = COVERAGE_UNCHECKED_WARNING;
  }

  return { error: null, ok: true, warning };
}
