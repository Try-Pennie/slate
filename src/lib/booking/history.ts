import { supabaseAdmin } from "../supabase/admin.ts";
import { unwrap } from "../db/result.ts";
import { selectAllPages, sortByStamp } from "../supabase/paginate.ts";
import {
  buildHistoryViews,
  type BookingEventView,
  type HistoryRosterUser,
  type ReasonOptionsByAction,
} from "./event-display.ts";
import { loadReasonOptions } from "./reason-options.ts";
import type { BookingEvent } from "../db/types.ts";

/** Every user id an event can reference, so we resolve names in one roster read. */
export function collectUserIds(events: BookingEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    for (const id of [
      e.actor_user_id,
      e.acting_as_user_id,
      e.from_agent_user_id,
      e.to_agent_user_id,
    ]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Injectable data seam so the assembly + tenant scoping are testable with fakes. */
export interface BookingHistoryDeps {
  /** The booking's org_id, or null if the booking does not exist. */
  bookingOrg: (bookingId: string) => Promise<string | null>;
  events: (bookingId: string) => Promise<BookingEvent[]>;
  users: (ids: string[]) => Promise<HistoryRosterUser[]>;
  /** The live reason options (incl. retired) so a renamed/custom code renders its
   *  exact current label (#346). Never throws (loader degrades to coded defaults). */
  reasonOptions: () => Promise<ReasonOptionsByAction>;
}

const defaultDeps: BookingHistoryDeps = {
  async bookingOrg(bookingId) {
    const row = unwrap(
      await supabaseAdmin()
        .from("bookings")
        .select("org_id")
        .eq("id", bookingId)
        .maybeSingle(),
      "booking-history org lookup",
    ) as { org_id: string } | null;
    return row?.org_id ?? null;
  },
  async events(bookingId) {
    return selectAllPages<BookingEvent>("booking_events history", "id", () =>
      supabaseAdmin()
        .from("booking_events")
        .select("*")
        .eq("booking_id", bookingId),
    ).then((rows) => sortByStamp("booking_events history", rows, "created_at", "id"));
  },
  async users(ids) {
    return unwrap(
      await supabaseAdmin().from("users").select("id,name,email").in("id", ids),
      "booking-history roster",
    ) as HistoryRosterUser[];
  },
  async reasonOptions() {
    const opts = await loadReasonOptions();
    return {
      reschedule: opts.reschedule.all,
      cancel: opts.cancel.all,
      reassign: opts.reassign.all,
    };
  },
};

/**
 * A booking's append-only reschedule/cancel/reassign history as newest-first
 * view models (#561). Tenant-scoped: returns null when the booking does not
 * exist OR belongs to a different org, so a manager can never read another
 * org's history by id. Reads route through unwrap / selectAllPages, so a real
 * DB error throws (fail-loud) rather than degrading to an empty history.
 */
export async function listBookingHistory(
  bookingId: string,
  orgId: string,
  deps: BookingHistoryDeps = defaultDeps,
): Promise<BookingEventView[] | null> {
  const bookingOrg = await deps.bookingOrg(bookingId);
  if (bookingOrg == null || bookingOrg !== orgId) return null;
  const events = await deps.events(bookingId);
  const ids = collectUserIds(events);
  const roster = ids.length ? await deps.users(ids) : [];
  const reasonOptions = await deps.reasonOptions();
  return buildHistoryViews(events, roster, reasonOptions);
}
