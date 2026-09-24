import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { SlateRule } from "@/lib/calcom/schedule-import";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * Write a week imported from cal.com, the zone and the rules together, stamped
 * `calcom-import` (#2627).
 *
 * The ONE write both importers use: the daily roster sweep
 * (`scripts/import-calcom-schedules.ts`) and the activation gate
 * (`src/lib/bookable/activation-hours.ts`). It goes through
 * `replace_user_schedule` (migration 0129), which resolves the schedule row by user
 * and calls `replace_availability_rules` inside the same transaction, so the zone
 * cannot land without its hours (#2002). The importer used to write the rules and
 * then the zone as two statements, and a run that died between them left an agent
 * with new hours read in their old zone until the next morning.
 *
 * THROWS on a refused write and on a count it did not ask for. The expected count is
 * checked inside the transaction (`p_expected`) and again here, because a client
 * that cannot read the count back has no business claiming a save either (L12).
 */
export async function writeImportedWeek(
  db: Db,
  userId: string,
  week: { timezone: string; rules: SlateRule[] },
): Promise<void> {
  const { data, error } = await db.rpc("replace_user_schedule", {
    p_user_id: userId,
    p_timezone: week.timezone,
    p_rules: week.rules,
    p_source: "calcom-import",
    p_expected: week.rules.length,
  });
  if (error) throw new Error(`imported week refused: ${error.message}`);
  const written = typeof data === "number" ? data : Number.NaN;
  if (written !== week.rules.length) {
    throw new Error(
      `imported week: asked for ${week.rules.length} rules, database recorded ${Number.isFinite(written) ? written : "an unreadable count"}`,
    );
  }
}
