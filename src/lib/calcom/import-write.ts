import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { SlateRule } from "@/lib/calcom/schedule-import";
import type { HoursSource } from "@/lib/monitor/unset-hours";
import { calcomHoursWriteRefusal, loadCalcomRetired, type RetiredReadDb } from "@/lib/calcom/retirement";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The SQLSTATE `replace_user_schedule` raises when a guarded write finds the row's
 * `hours_source` is no longer the one the caller read (#2702, migration 0157). A
 * custom code rather than a message match, so rewording the exception cannot turn
 * the refusal back into an ordinary failure.
 */
export const HOURS_CHANGED_SQLSTATE = "SL409";

/**
 * A guarded import refused because somebody wrote the week between the caller's
 * read and this write (#2702). Not a failure: the week holds what a person set, and
 * leaving it is the point of the guard.
 */
export class HoursChangedDuringImportError extends Error {
  constructor(userId: string, detail: string) {
    super(`imported week not written for ${userId}: the stored hours changed during the import (${detail})`);
    this.name = "HoursChangedDuringImportError";
  }
}

/** Who wrote the week the caller judged. null = written before the stamp existed. */
type ExpectedSource = HoursSource | null;

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
 *
 * GUARDED, when `opts.onlyIfSource` is given (#2702). The activation gate decides to
 * import only after reading the stored week and judging it unset, and an admin save
 * landing between that read and this write used to be overwritten with nothing said.
 * So the caller passes the source it read (null for a row written before the stamp
 * existed) and `replace_user_schedule` compares it against the row it has LOCKED,
 * inside the same transaction as the write, refusing with `HOURS_CHANGED_SQLSTATE`
 * when they differ. That refusal throws `HoursChangedDuringImportError`, so the
 * caller can tell it from a write that failed. The daily importer passes no guard:
 * its rule (Dan, 2026-09-10) is to overwrite an admin edit, so it reaches the
 * unguarded five argument form, unchanged.
 */
export async function writeImportedWeek(
  db: Db,
  userId: string,
  week: { timezone: string; rules: SlateRule[] },
  opts: { onlyIfSource?: ExpectedSource } = {},
): Promise<void> {
  const refusal = calcomHoursWriteRefusal(await loadCalcomRetired(db as unknown as RetiredReadDb));
  if (refusal) throw new Error(`imported week not written: ${refusal}`);
  // Only undefined means unguarded: an explicit null is a guard (still unstamped),
  // and treating it as absent would send the write to the unguarded form. Each call
  // spells out its own literal source, so the stamp guard can read it.
  const guarded = opts.onlyIfSource !== undefined;
  const { data, error } = guarded
    ? await db.rpc("replace_user_schedule", {
        p_user_id: userId,
        p_timezone: week.timezone,
        p_rules: week.rules,
        p_source: "calcom-import",
        p_expected: week.rules.length,
        p_only_if_source: opts.onlyIfSource ?? null,
      })
    : await db.rpc("replace_user_schedule", {
        p_user_id: userId,
        p_timezone: week.timezone,
        p_rules: week.rules,
        p_source: "calcom-import",
        p_expected: week.rules.length,
      });
  if (error && guarded && (error as { code?: string }).code === HOURS_CHANGED_SQLSTATE) {
    throw new HoursChangedDuringImportError(userId, error.message);
  }
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
