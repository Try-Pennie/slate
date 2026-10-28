import { rosterNameResolver, type HistoryRosterUser, type NameResolver } from "./event-display.ts";
import type { Booking, Role, RoutingTrace } from "../db/types.ts";
import { bookingSourceLabel } from "./booking-source.ts";

/** The booking fields the detail view reads (a subset of Booking). */
export type BookingDetailInput = Pick<
  Booking,
  | "attendee_name"
  | "attendee_email"
  | "attendee_phone"
  | "status"
  | "starts_at"
  | "ends_at"
  | "original_starts_at"
  | "assigned_user_id"
  | "routing_trace"
  | "source"
> & {
  /**
   * The bucket the row is stored in, joined by the page's read. A call a coordinator
   * books on the placeholder is never routed, so it has no routing_trace, and this is
   * the only place its bucket can come from.
   */
  buckets?: { code?: string | null } | null;
};

export interface BookingDetailTraceView {
  /**
   * The agents routing weighed, BY NAME (#1943).
   *
   * It was a count, and the page printed the length of a list it was already
   * holding: "2 agents considered" while the ids sat right there. An id that
   * cannot be resolved says so rather than rendering eight hex characters, which
   * is the same fault #1914 fixed on the routing table: an unresolved id is a
   * detection that the roster is missing somebody, not a name (L67).
   */
  considered: string[];
  fallbackApplied: boolean;
  reassignments: { from: string; to: string }[];
}

export interface BookingDetailView {
  attendee: string;
  email: string | null;
  phone: string | null;
  status: string;
  /**
   * The start and end INSTANTS (#1916). Not formatted here: this runs on the
   * server, which cannot know who is reading, so the page renders them in the
   * viewer's zone, labelled, through `ViewerTime`.
   */
  startsAt: string;
  endsAt: string;
  /** The pre-reschedule start instant, or null if never rescheduled. */
  rescheduledFrom: string | null;
  agentName: string;
  bucketCode: string | null;
  /** Where the booking came from, with its legacy cal.com event type (#2072). */
  source: string;
  trace: BookingDetailTraceView | null;
}

/**
 * Whether anything can still change this booking (#1943).
 *
 * ONE predicate, so the page and the actions control cannot disagree about
 * whether there are actions: a card that renders while its contents refuse is an
 * empty card, which is what this issue is about.
 *
 * It lives HERE rather than beside the control, because the control is a client
 * component and the page that decides whether to draw the card is a server one.
 * An export from a `"use client"` module is a client REFERENCE on the server,
 * not a function, so calling it during server render throws: that is exactly
 * what happened when it was first written next to the control, and the page's
 * own error boundary caught it.
 */
export function bookingIsActionable(status: string): boolean {
  return status !== "cancelled" && status !== "completed";
}

/** The detail-page URL for a booking, used by every surface that links to it
 *  (the admin recent-routing row and the booking lookup), so the path lives in
 *  one place. */
export function bookingDetailHref(bookingId: string): string {
  return `/admin/bookings/${encodeURIComponent(bookingId)}`;
}

function traceView(t: RoutingTrace, nameOf: NameResolver): BookingDetailTraceView {
  return {
    considered: t.considered.map(nameOf),
    fallbackApplied: t.fallback_applied,
    reassignments: (t.reassignments ?? []).map((r) => ({
      from: nameOf(r.from),
      to: nameOf(r.to),
    })),
  };
}

/**
 * Derive the per-booking detail view (#900): attendee, times (with the
 * pre-reschedule start when moved), assigned agent, bucket, and a resolved
 * routing-trace summary. Pure: the page pairs it with a roster name resolver
 * and reuses the shared AdminBookingActions / BookingHistory components.
 */
export function bookingDetailView(
  b: BookingDetailInput,
  nameOf: NameResolver,
): BookingDetailView {
  const rescheduled =
    b.original_starts_at != null && b.original_starts_at !== b.starts_at;
  return {
    attendee: b.attendee_name || b.attendee_email || b.attendee_phone || "(no name)",
    email: b.attendee_email,
    phone: b.attendee_phone,
    status: b.status,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    rescheduledFrom: rescheduled ? b.original_starts_at : null,
    agentName: b.assigned_user_id ? nameOf(b.assigned_user_id) : "Unassigned",
    // The bucket routing chose, else the one the row is stored in: a placed call has
    // no trace, and without a code the move panel asks for no times at all.
    bucketCode: b.routing_trace?.bucket_code ?? b.buckets?.code ?? null,
    // A row read before the migration lands has no field at all: the same fact
    // as null, a booking made before sources were recorded.
    source: bookingSourceLabel(b.source ?? null),
    trace: b.routing_trace ? traceView(b.routing_trace, nameOf) : null,
  };
}

/** The page's decision after guarding + loading; the page performs the matching
 *  navigation (redirect / notFound) so this stays free of next/navigation. */
export type BookingDetailResult =
  | { kind: "forbidden" }
  | { kind: "ooo" }
  | { kind: "notfound" }
  | { kind: "ok"; booking: Booking; view: BookingDetailView };

/** Injectable seam for the detail page's guard + tenant-scoped load. */
export interface BookingDetailPageDeps {
  role: Role;
  orgId: string;
  canManage: (role: Role) => boolean;
  oooOnly: (role: Role) => boolean;
  getBooking: (id: string, orgId: string) => Promise<Booking | null>;
  getRoster: (orgId: string) => Promise<HistoryRosterUser[]>;
}

/**
 * Guard + load for the per-booking detail page (#900): manager+ only, redirected
 * to OOO during the OOO-only launch, and tenant-scoped so a booking outside the
 * caller's org is a 404. Returns a decision; the page performs the navigation.
 */
export async function loadBookingDetail(
  id: string,
  deps: BookingDetailPageDeps,
): Promise<BookingDetailResult> {
  // The console gate answers first (#2699): while the console is hidden, every
  // console route sends a held out viewer to the OOO page, and a role refusal
  // here would name a rule that is not the one keeping them out.
  if (deps.oooOnly(deps.role)) return { kind: "ooo" };
  if (!deps.canManage(deps.role)) return { kind: "forbidden" };
  const booking = await deps.getBooking(id, deps.orgId);
  if (!booking) return { kind: "notfound" };
  const roster = await deps.getRoster(deps.orgId);
  const view = bookingDetailView(booking, rosterNameResolver(roster));
  return { kind: "ok", booking, view };
}
