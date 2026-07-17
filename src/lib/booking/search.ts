import { supabaseAdmin } from "../supabase/admin.ts";
import { unwrap } from "../db/result.ts";
import {
  rosterNameResolver,
  type HistoryRosterUser,
} from "./event-display.ts";

/** Max booking rows a lookup returns (bounds the growth-table read, cap-safe). */
const SEARCH_LIMIT = 20;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the query is a booking id (a UUID), so it routes to an exact lookup. */
export function isBookingIdQuery(q: string): boolean {
  return UUID_RE.test(q.trim());
}

/** The booking columns a lookup reads (and the id the History panel needs). */
export interface BookingSearchInput {
  id: string;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  starts_at: string;
  assigned_user_id: string | null;
  status: string;
}

/** A compact result row the lookup list renders (each carries the History toggle). */
export interface BookingSearchRow {
  id: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  attendeePhone: string | null;
  /** ISO; the client formats it in the roster zone. */
  startsAt: string;
  agentName: string;
  status: string;
}

/** Map booking rows to result rows, resolving the assigned agent's name. */
export function buildSearchRows(
  bookings: BookingSearchInput[],
  roster: HistoryRosterUser[],
): BookingSearchRow[] {
  const nameOf = rosterNameResolver(roster);
  return bookings.map((b) => ({
    id: b.id,
    attendeeName: b.attendee_name,
    attendeeEmail: b.attendee_email,
    attendeePhone: b.attendee_phone,
    startsAt: b.starts_at,
    agentName: b.assigned_user_id ? nameOf(b.assigned_user_id) : "Unassigned",
    status: b.status,
  }));
}

/** Injectable data seam so tenant scoping + routing are testable with fakes. */
export interface BookingSearchDeps {
  byId: (id: string, orgId: string) => Promise<BookingSearchInput[]>;
  byText: (q: string, orgId: string, limit: number) => Promise<BookingSearchInput[]>;
  users: (ids: string[]) => Promise<HistoryRosterUser[]>;
  limit?: number;
}

const defaultDeps: BookingSearchDeps = {
  async byId(id, orgId) {
    return unwrap(
      await supabaseAdmin()
        .from("bookings")
        .select(
          "id,attendee_name,attendee_email,attendee_phone,starts_at,assigned_user_id,status",
        )
        .eq("org_id", orgId)
        .eq("id", id),
      "booking-search by id",
    ) as BookingSearchInput[];
  },
  async byText(q, orgId, limit) {
    const like = `%${q}%`;
    return unwrap(
      await supabaseAdmin()
        .from("bookings")
        .select(
          "id,attendee_name,attendee_email,attendee_phone,starts_at,assigned_user_id,status",
        )
        .eq("org_id", orgId)
        .or(
          `attendee_email.ilike.${like},attendee_name.ilike.${like},attendee_phone.ilike.${like}`,
        )
        .order("starts_at", { ascending: false })
        .limit(limit),
      "booking-search by text",
    ) as BookingSearchInput[];
  },
  async users(ids) {
    if (!ids.length) return [];
    return unwrap(
      await supabaseAdmin().from("users").select("id,name,email").in("id", ids),
      "booking-search roster",
    ) as HistoryRosterUser[];
  },
};

/**
 * Find bookings for the lookup viewer (#901): a UUID query routes to an exact,
 * tenant-scoped id lookup; any other non-empty query matches attendee
 * email/name/phone (bounded to SEARCH_LIMIT). A blank query does no read and
 * returns []. Reads route through unwrap so a fault throws rather than degrading
 * to an empty result set.
 */
export async function searchBookings(
  orgId: string,
  query: string,
  deps: BookingSearchDeps = defaultDeps,
): Promise<BookingSearchRow[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = deps.limit ?? SEARCH_LIMIT;
  const bookings = isBookingIdQuery(q)
    ? await deps.byId(q, orgId)
    : await deps.byText(q, orgId, limit);
  const agentIds = [
    ...new Set(bookings.map((b) => b.assigned_user_id).filter((v): v is string => !!v)),
  ];
  const roster = agentIds.length ? await deps.users(agentIds) : [];
  return buildSearchRows(bookings, roster);
}
