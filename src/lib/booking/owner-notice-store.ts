import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";

/**
 * The one read the owner reassign notice needs of its own (#2372): which zone the
 * advisor keeps their week in.
 *
 * Deliberately NOT `fetchAgentWorkingHours`, which the booking deps already expose.
 * That one answers `America/New_York` for an agent with no schedule at all, and
 * swallows a read error into the same answer, because its caller is the reschedule
 * guard, for which an unknown week must read as off shift. Handed to a Slack notice
 * instead, that default becomes a sentence telling the sales team an advisor is in
 * Eastern when nothing established it (L192), and the roster is not Eastern: it spans
 * seven zones, with 27 in Phoenix and 16 in Los Angeles (#1739).
 *
 * So this answers `null` for an advisor with no schedule row, and THROWS on a read
 * that failed. Those are two different things and the caller treats them differently:
 * the first is a notice that says less, the second leaves the outbox step to retry.
 * An empty answer standing in for an unreadable one is the whole #277 class.
 *
 * `availability_schedules` is roster bounded (it is on the capped read guard's
 * SAFE_TABLES) and this is one agent's row, bounded again by `limit(1)`.
 */
export async function loadAdvisorTimezone(
  db: ReturnType<typeof supabaseAdmin>,
  userId: string,
): Promise<string | null> {
  const rows = unwrap(
    await db.from("availability_schedules").select("timezone").eq("user_id", userId).limit(1),
    "advisor timezone",
  ) as { timezone: string | null }[] | null;
  const zone = rows?.[0]?.timezone;
  return zone && zone.trim() ? zone.trim() : null;
}
