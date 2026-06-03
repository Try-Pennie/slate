"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, requireAdmin } from "@/lib/auth";
import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import type { Attributes } from "@/lib/db/types";

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

const ROUTING_KEYS = ["debt_team", "backend_service", "role", "legal_eligible"];

export async function createBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const memberIds = form.getAll("members").map(String).filter(Boolean);

  // Build attribute criteria from any filled routing fields (blank = not filtered).
  const criteria: Record<string, string> = {};
  for (const key of ROUTING_KEYS) {
    const v = String(form.get(`crit_${key}`) ?? "").trim();
    if (v) criteria[key] = v;
  }

  const { data: bucket, error } = await supabaseAdmin()
    .from("buckets")
    .insert({
      org_id: admin.org_id,
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      event_type_id: String(form.get("event_type_id") ?? ""),
      criteria,
    })
    .select("id")
    .single();

  if (!error && bucket && memberIds.length) {
    await supabaseAdmin().from("bucket_members").insert(
      memberIds.map((user_id) => ({
        bucket_id: (bucket as { id: string }).id,
        user_id,
      })),
    );
  }
  revalidatePath("/admin");
}

export async function setWorkingHours(form: FormData): Promise<void> {
  await requireAdmin();
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
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
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;

  const { data: org } = await db
    .from("organizations")
    .select(
      "default_timezone, default_start_minute, default_end_minute, default_weekdays",
    )
    .eq("id", admin.org_id)
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
  await requireAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  await supabaseAdmin()
    .from("users")
    .update({ bookable: form.get("bookable") === "true" })
    .eq("id", userId);
  revalidatePath("/admin");
}

export async function setAgentAttributes(form: FormData): Promise<void> {
  await requireAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;

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
