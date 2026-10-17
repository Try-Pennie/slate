import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import { OWNER_NOTICE_STEP, OWNER_NOTICE_WITHHELD } from "@/lib/booking/owner-notice-withheld";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The IO half of the weekly withheld notice count (#2440): outbox rows created since
 * `sinceIso` whose owner notice step carries the `no_handoff_channel` reason.
 *
 * A server side count (`head: true`), so `booking_outbox` being a growth table costs
 * no page of rows, and one subrequest on the lane four cron lanes share. The match is
 * jsonb containment on the steps array, so it finds exactly the step the handler
 * marked, wherever it sits in the array.
 *
 * THROWS on a failed count (`unwrapCount`): a null count read as zero would be the
 * report saying nothing was withheld off a query that never ran (#1165).
 */
export async function countWithheldOwnerNotices(db: Db, sinceIso: string): Promise<number> {
  return unwrapCount(
    await db
      .from("booking_outbox")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso)
      .filter("steps", "cs", JSON.stringify([{ name: OWNER_NOTICE_STEP, withheld: OWNER_NOTICE_WITHHELD.noChannel }])),
    "owner notices withheld",
  );
}
