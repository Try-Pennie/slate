"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, requireAdmin, requireManager } from "@/lib/auth";
import { canManageUser, canChangeRole, isRole } from "@/lib/auth/roles";
import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import { replayDeadLetteredDeliveries, resendDelivery } from "@/lib/webhooks/emit";
import { recordAudit, type AuditAction } from "@/lib/audit";
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
  const { data: existing } = await db
    .from("availability_schedules")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  let scheduleId = (existing as { id: string } | null)?.id;
  if (scheduleId) {
    await db
      .from("availability_schedules")
      .update({ timezone })
      .eq("id", scheduleId);
  } else {
    const { data: created } = await db
      .from("availability_schedules")
      .insert({ user_id: userId, timezone })
      .select("id")
      .single();
    scheduleId = (created as { id: string }).id;
  }
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
    toMinutes(String(form.get("end") ?? "17:00")),
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
  await syncSalesforceAgents();
  revalidatePath("/admin");
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
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  await requireManageAgent(userId, "agent.hours");
  const timezone = String(form.get("timezone") ?? "America/New_York");
  const startMinute = toMinutes(String(form.get("start") ?? "09:00"));
  const endMinute = toMinutes(String(form.get("end") ?? "17:00"));
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) =>
    form.get(`day_${d}`),
  );

  // One schedule per user for the PoC: upsert it, then replace its rules.
  const { data: existing } = await db
    .from("availability_schedules")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  let scheduleId = (existing as { id: string } | null)?.id;
  if (scheduleId) {
    await db
      .from("availability_schedules")
      .update({ timezone })
      .eq("id", scheduleId);
  } else {
    const { data: created } = await db
      .from("availability_schedules")
      .insert({ user_id: userId, timezone })
      .select("id")
      .single();
    scheduleId = (created as { id: string }).id;
  }

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
  revalidatePath("/admin");
}

export async function setOrgDefaultHours(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`dday_${d}`));
  await supabaseAdmin()
    .from("organizations")
    .update({
      default_timezone: String(form.get("default_timezone") ?? "America/New_York"),
      default_start_minute: toMinutes(String(form.get("default_start") ?? "09:00")),
      default_end_minute: toMinutes(String(form.get("default_end") ?? "17:00")),
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

  const { data: existing } = await db
    .from("availability_schedules")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  let scheduleId = (existing as { id: string } | null)?.id;
  if (!scheduleId) {
    const { data: created } = await db
      .from("availability_schedules")
      .insert({ user_id: userId, timezone: o.default_timezone })
      .select("id")
      .single();
    scheduleId = (created as { id: string }).id;
  }

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
  await supabaseAdmin()
    .from("users")
    .update({ bookable: form.get("bookable") === "true" })
    .eq("id", userId);
  revalidatePath("/admin");
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

  const { count } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
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

/** Admin-only: re-fire a webhook delivery from the delivery log. */
export async function resendWebhookDelivery(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const deliveryId = String(form.get("delivery_id") ?? "");
  if (!deliveryId) return;
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
      .update({ url, format, auth_header: authHeader })
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

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
