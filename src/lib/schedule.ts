import { supabaseAdmin } from "@/lib/supabase/admin";
import { defaultRuleRows, type OrgDefaults } from "@/lib/schedule-core";

/**
 * Get-or-create the single schedule row for a user and return its id, setting
 * its timezone. One row per user is enforced by the availability_schedules
 * (user_id) unique index (#532), so this upserts on that conflict target rather
 * than the check-then-insert the admin hours actions used to duplicate: two
 * concurrent edits now settle on the index (the loser updates the winner's row)
 * instead of racing to a second, silently-divergent schedule.
 */
export async function upsertUserSchedule(
  userId: string,
  timezone: string,
): Promise<string> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("availability_schedules")
    .upsert({ user_id: userId, timezone }, { onConflict: "user_id" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`schedule upsert failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
}

/**
 * Gives every agent without a working-hours schedule the org default
 * (newly-synced agents arrive schedule-less and would show zero availability
 * once bookable). Idempotent: agents with a schedule are never touched, so
 * hours personalized on /me survive. Returns how many agents were filled in.
 */
export async function ensureDefaultSchedules(orgId: string): Promise<number> {
  const db = supabaseAdmin();

  const { data: org } = await db
    .from("organizations")
    .select(
      "default_timezone, default_start_minute, default_end_minute, default_weekdays",
    )
    .eq("id", orgId)
    .single();
  if (!org) return 0;
  const defaults = org as unknown as OrgDefaults;

  const [{ data: users }, { data: schedules }] = await Promise.all([
    db.from("users").select("id").eq("org_id", orgId),
    db.from("availability_schedules").select("user_id"),
  ]);
  const covered = new Set(
    (schedules ?? []).map((s) => (s as { user_id: string }).user_id),
  );
  const missing = ((users ?? []) as { id: string }[]).filter(
    (u) => !covered.has(u.id),
  );
  if (missing.length === 0) return 0;

  // Upsert (not insert) so a concurrent fill settles on the (user_id) unique
  // index (#532): ignoreDuplicates makes each already-covered agent a no-op, and
  // .select returns only the rows this call actually created, so rules are added
  // for exactly those.
  const { data: created, error } = await db
    .from("availability_schedules")
    .upsert(
      missing.map((u) => ({
        user_id: u.id,
        timezone: defaults.default_timezone,
      })),
      { onConflict: "user_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error || !created) {
    throw new Error(`default schedules insert failed: ${error?.message}`);
  }

  const rules = (created as { id: string }[]).flatMap((s) =>
    defaultRuleRows(s.id, defaults),
  );
  if (rules.length) {
    const { error: ruleError } = await db
      .from("availability_rules")
      .insert(rules);
    if (ruleError) {
      throw new Error(`default rules insert failed: ${ruleError.message}`);
    }
  }
  return created.length;
}
