import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { SlateRule } from "@/lib/calcom/schedule-import";
import { calcomHoursWriteRefusal, loadCalcomRetired, type RetiredReadDb } from "@/lib/calcom/retirement";

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
 * REFUSES once cal.com is retired (#2875), and when that cannot be read, before
 * anything is written. It is read FRESH on every call, never through the per
 * isolate cache: the hours Slate holds become the record at cutover, and a week
 * written from cal.com after that replaces somebody's edit with stale hours and
 * says nothing. The rule lives here rather than in either caller because this is
 * the one write both importers share, so a third importer is covered by
 * construction (L593). An unreadable setting refuses, the opposite of what the
 * monitoring lanes do with the same failure, because this is the one consumer
 * whose wrong answer cannot be taken back: the next run repairs a missed day, and
 * nothing repairs an overwritten one.
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
  const refusal = calcomHoursWriteRefusal(await loadCalcomRetired(db as unknown as RetiredReadDb));
  if (refusal) throw new Error(`imported week not written: ${refusal}`);
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

/**
 * Record `calcom-import` as the source of a week that ALREADY matches cal.com and
 * carries no source, without rewriting it.
 *
 * Weeks written before migration 0117 (#1753) carry a null `hours_source`, and a
 * matching week was never written by the import, so the source stayed null for
 * ever (`importAction` in `schedule-import.ts` decides when this runs).
 *
 * ONE narrow write that sets only `hours_source` and `hours_set_at`. The rules and
 * the zone are not touched, because they already equal what an import would write;
 * sending them back through `replace_user_schedule` would delete and reinsert the
 * rules for no change. The update is filtered on `hours_source is null`, so it can
 * never overwrite a stamp another writer (an agent saving their own week a second
 * earlier) put there, and a second run finds nothing to update. Direct table writes
 * by the secret key client are the established path for this stamp
 * (`fillMissingSchedules` in `src/lib/schedule.ts` stamps `seed` the same way).
 *
 * Refuses once cal.com is retired, on the same fresh read `writeImportedWeek` uses
 * (#2875): a week stamped `calcom-import` after cutover would claim cal.com set it.
 *
 * Returns `stamped` when it wrote the row, `already-set` when the source was no
 * longer null (nothing written). THROWS on a refused write and on a result it cannot
 * read back, so a failed stamp is a failure and never a match (L12).
 */
export async function stampImportedSource(
  db: Db,
  scheduleId: string,
): Promise<"stamped" | "already-set"> {
  const refusal = calcomHoursWriteRefusal(await loadCalcomRetired(db as unknown as RetiredReadDb));
  if (refusal) throw new Error(`source not stamped: ${refusal}`);
  const { data, error } = await db
    .from("availability_schedules")
    .update({ hours_source: "calcom-import", hours_set_at: new Date().toISOString() })
    .eq("id", scheduleId)
    .is("hours_source", null)
    .select("id");
  if (error) throw new Error(`source stamp refused: ${error.message}`);
  if (!Array.isArray(data)) throw new Error("source stamp: the database returned an unreadable result");
  return data.length > 0 ? "stamped" : "already-set";
}
