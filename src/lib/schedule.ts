import { supabaseAdmin } from "@/lib/supabase/admin";
import { defaultRuleRows, type OrgDefaults } from "@/lib/schedule-core";

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

  const { data: created, error } = await db
    .from("availability_schedules")
    .insert(
      missing.map((u) => ({
        user_id: u.id,
        timezone: defaults.default_timezone,
      })),
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
