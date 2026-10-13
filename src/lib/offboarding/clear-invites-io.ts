import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { deleteEvent } from "@/lib/google/calendar";
import { coverageInvites } from "@/lib/booking/bulk-reassign-store";
import {
  CLEAR_INVITES_BUDGET_MS,
  CLEAR_INVITES_CONCURRENCY,
  clearLeaverInvites,
  type ClearInvitesResult,
} from "@/lib/offboarding/clear-invites";

/**
 * The reads and the Google calls behind `clearLeaverInvites` (#3667), for one
 * departed advisor: their address (the invites are on their calendar) and the
 * invites on the calls the coverage sweep will move. Each invite is deleted without
 * emailing the lead, the way a reassign removes an old invite (#969), because the
 * lead's call is not cancelled: the sweep sends the new advisor's invite next.
 * THROWS on a failed read, so the caller reports it rather than reading nothing.
 */
export async function clearInvitesForLeaver(userId: string, deactivatedAtIso: string): Promise<ClearInvitesResult> {
  return clearLeaverInvites({
    loadInvites: async () => {
      const user = unwrap(
        await supabaseAdmin()
          // cap-safe: single-row primary-key lookup.
          .from("users")
          .select("email")
          .eq("id", userId)
          .maybeSingle(),
        "offboarding-clear-invites-email",
      ) as { email: string | null } | null;
      if (!user?.email) throw new Error("offboarding clear invites: the departed advisor has no address on record");
      const email = user.email;
      const rows = await coverageInvites(userId, deactivatedAtIso);
      return rows.map((r) => ({ bookingId: r.id, eventId: r.gcal_event_id, organizerEmail: email }));
    },
    deleteInvite: (email, eventId) => deleteEvent(email, eventId, { notifyAttendee: false }),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    budgetMs: CLEAR_INVITES_BUDGET_MS,
    concurrency: CLEAR_INVITES_CONCURRENCY,
  });
}
