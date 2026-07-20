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
import { writeBookable } from "@/lib/bookable/service";
import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import { replayDeadLetteredDeliveries, resendDelivery } from "@/lib/webhooks/emit";
import { acquireLock } from "@/lib/locks";
import { recordAudit, type AuditAction } from "@/lib/audit";
import {
  parseMonitorSettingsForm,
  ALERT_KEYS as MONITOR_ALERT_KEYS,
  type MonitorAlertKey,
} from "@/lib/monitor/settings";
import { __clearChannelCache } from "@/lib/notify/channels";
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
  await recordAudit({ orgId: actor.org_id, actorId: actor.id, action, targetId: userId });
  return actor;
}

/** Replaces a user's weekly schedule (one schedule row + its rules). */
async function replaceUserSchedule(
  userId: string,
  timezone: string,
  weekdays: number[],
  startMinute: number,
  endMinute: number,
): Promise<void> {
  const db = supabaseAdmin();
  const scheduleId = await upsertUserSchedule(userId, timezone);
  await db.from("availability_rules").delete().eq("schedule_id", scheduleId);
  if (weekdays.length && endMinute > startMinute) {
    await db.from("availability_rules").insert(
      weekdays.map((weekday) => ({
        schedule_id: scheduleId,
        weekday,
        start_minute: startMinute,
        end_minute: endMinute,
      })),
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

export async function setOrgDefaultHours(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`dday_${d}`));
  await supabaseAdmin()
    .from("organizations")
    .update({
      default_timezone: String(form.get("default_timezone") ?? "America/New_York"),
      default_start_minute: toMinutes(String(form.get("default_start") ?? "09:00")),
      default_end_minute: toMinutes(
        roundUpToQuarterHour(String(form.get("default_end") ?? "17:00")),
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
  // Shared with the bookable-toggle API (#281). The admin toggle intentionally
  // skips the API's Google-reachability guard: a human is making a deliberate
  // call here, and the read-only pill on the page already shows calendar health.
  await writeBookable(userId, form.get("bookable") === "true");
  revalidatePath("/admin");
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
  if (!email) redirect(`/admin?imp_error=${encodeURIComponent("Enter an email.")}`);

  const { data } = await supabaseAdmin()
    .from("users")
    .select("id, role")
    .eq("org_id", admin.org_id)
    .eq("email", email)
    .maybeSingle();
  const target = data as { id: string; role: Role } | null;
  if (!target) {
    redirect(`/admin?imp_error=${encodeURIComponent(`No user with email ${email}.`)}`);
  }
  if (target.id === admin.id) {
    redirect(`/admin?imp_error=${encodeURIComponent("That is already you.")}`);
  }
  // Role ceiling (#588): can't view-as someone who outranks or equals you.
  if (!canImpersonate(admin.role, target.role)) {
    redirect(
      `/admin?imp_error=${encodeURIComponent(`You can't impersonate a ${roleLabel(target.role)}.`)}`,
    );
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
    targetId: target.id,
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
      targetId,
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
      targetId,
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
    targetId: userId,
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

  const { count } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .in("role", ["admin", "super_admin"]);
  if (!canChangeRole(current, next, count ?? 0)) {
    throw new Error("Cannot remove the last admin");
  }

  await db.from("users").update({ role: next }).eq("id", userId);
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "role.set",
    targetId: userId,
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
  if (!claim) return; // a duplicate/racing request already re-fired this delivery
  await resendDelivery(deliveryId, admin.org_id);
  revalidatePath("/admin");
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
