import { supabaseAdmin } from "../supabase/admin.ts";
import { unwrap } from "../db/result.ts";
import { escapeLike } from "../sql-like.ts";
import { compareStringsDesc } from "../compare.ts";
import {
  rosterNameResolver,
  type HistoryRosterUser,
} from "./event-display.ts";

/** Max booking rows a lookup returns (bounds the growth-table read, cap-safe).
 *  Exported so the lookup UI can tell when a text result filled the bound (#903). */
export const SEARCH_LIMIT = 20;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns a text lookup matches, each searched as its OWN query (#1046).
 *
 * This used to be one PostgREST `.or()` filter string with the query interpolated
 * into it. PostgREST parses that string as grammar, so a comma or a parenthesis in
 * what somebody typed either injected extra OR clauses or broke the parse outright:
 * searching for "Doe, Jane" errored. One `.ilike()` per column leaves supabase-js
 * to encode each value, so there is no grammar to inject into, and it matches the
 * shape the person lookup in `service.ts` already uses.
 *
 * Order is the order the queries are issued in, which the tests assert on.
 */
export const TEXT_SEARCH_COLUMNS = [
  "attendee_email",
  "attendee_name",
  "attendee_phone",
] as const;

/**
 * The ILIKE pattern a text lookup matches with: the query as a LITERAL substring.
 *
 * `escapeLike` is what makes it literal (#620): `_` and `%` are ILIKE wildcards, so
 * a search for `john_doe@` would otherwise also return `johnXdoe@`, and a lone `%`
 * would return every booking in the org. The surrounding `%` are ours, added after
 * the escaping, so they stay wildcards.
 */
export function textSearchPattern(q: string): string {
  return `%${escapeLike(q)}%`;
}

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
  /** Whether the booking's bucket is a test bucket (#2660), read off the joined
   *  bucket: `bookings` carries no flag of its own. */
  is_test: boolean;
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
  /** A booking on a test bucket (#2660): a tester's, never a lead's. Shown, and
   *  marked, so it is never read as a customer. */
  isTest: boolean;
}

/** What the joined read hands back per row, before the flag is lifted out. */
type JoinedRow = Omit<BookingSearchInput, "is_test"> & { buckets: { is_test: boolean } | null };

/** The projection every bookings read here asks for: the row plus its bucket's
 *  flag, through the same inner join the monitors use. */
const SEARCH_SELECT =
  "id,attendee_name,attendee_email,attendee_phone,starts_at,assigned_user_id,status,buckets!inner(is_test)";

function liftFlag(rows: JoinedRow[] | null): BookingSearchInput[] {
  return (rows ?? []).map(({ buckets, ...row }) => ({ ...row, is_test: buckets?.is_test === true }));
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
    isTest: b.is_test,
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
    return liftFlag(
      unwrap(
        await supabaseAdmin()
          .from("bookings")
          .select(SEARCH_SELECT)
          .eq("org_id", orgId)
          .eq("id", id),
        "booking-search by id",
      ) as JoinedRow[] | null,
    );
  },
  async byText(q, orgId, limit) {
    const pattern = textSearchPattern(q);
    // One bounded, org-scoped query per column, merged here. Each is ordered and
    // limited the same way the single query was, which returns the same rows: the
    // newest `limit` matches overall are a subset of the newest `limit` matches per
    // column, so nothing the combined query would have shown is lost.
    const results = await Promise.all(
      TEXT_SEARCH_COLUMNS.map((column) =>
        supabaseAdmin()
          .from("bookings")
          .select(SEARCH_SELECT)
          .eq("org_id", orgId)
          .ilike(column, pattern)
          .order("starts_at", { ascending: false })
          .limit(limit),
      ),
    );
    const byId = new Map<string, BookingSearchInput>();
    for (const r of results) {
      const rows = liftFlag(unwrap(r, "booking-search by text") as JoinedRow[] | null);
      // A booking matching on two columns arrives twice; the map keeps one.
      for (const row of rows) byId.set(row.id, row);
    }
    return [...byId.values()]
      .sort((a, b) => compareStringsDesc(a.starts_at, b.starts_at))
      .slice(0, limit);
  },
  async users(ids) {
    if (!ids.length) return [];
    return unwrap(
      await supabaseAdmin().from("users").select("id,name,email").in("id", ids),
      "booking-search roster",
    ) as HistoryRosterUser[];
  },
};

/** A lookup result: the rows plus whether the text search filled its bound
 *  (so there may be more matches the user isn't seeing, #903). */
export interface BookingSearchResult {
  rows: BookingSearchRow[];
  truncated: boolean;
}

/**
 * Find bookings for the lookup viewer (#901): a UUID query routes to an exact,
 * tenant-scoped id lookup; any other non-empty query matches attendee
 * email/name/phone (bounded to SEARCH_LIMIT). A blank query does no read and
 * returns no rows. A text search that fills the bound is flagged `truncated` so
 * the UI can prompt the user to narrow it (#903); an id lookup never is. Reads
 * route through unwrap so a fault throws rather than degrading to empty.
 */
export async function searchBookings(
  orgId: string,
  query: string,
  deps: BookingSearchDeps = defaultDeps,
): Promise<BookingSearchResult> {
  const q = query.trim();
  if (!q) return { rows: [], truncated: false };
  const limit = deps.limit ?? SEARCH_LIMIT;
  const byId = isBookingIdQuery(q);
  const bookings = byId
    ? await deps.byId(q, orgId)
    : await deps.byText(q, orgId, limit);
  const truncated = !byId && bookings.length >= limit;
  const agentIds = [
    ...new Set(bookings.map((b) => b.assigned_user_id).filter((v): v is string => !!v)),
  ];
  const roster = agentIds.length ? await deps.users(agentIds) : [];
  return { rows: buildSearchRows(bookings, roster), truncated };
}
