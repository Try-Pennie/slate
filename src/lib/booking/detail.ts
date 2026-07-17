import { formatSlotDay, formatSlotTime } from "./slot-label.ts";
import { rosterNameResolver, type HistoryRosterUser, type NameResolver } from "./event-display.ts";
import type { Booking, Role, RoutingTrace } from "../db/types.ts";

/** The whole roster is Eastern (matches the history/lookup formatting). */
const ROSTER_ZONE = "America/New_York";

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
>;

export interface BookingDetailTraceView {
  considered: number;
  fallbackApplied: boolean;
  reassignments: { from: string; to: string }[];
}

export interface BookingDetailView {
  attendee: string;
  email: string | null;
  phone: string | null;
  status: string;
  /** Start formatted in the roster zone, e.g. "Fri, Jul 3, 2:00 PM". */
  when: string;
  ends: string;
  /** The pre-reschedule start (formatted), or null if never rescheduled. */
  rescheduledFrom: string | null;
  agentName: string;
  bucketCode: string | null;
  trace: BookingDetailTraceView | null;
}

/** The detail-page URL for a booking, used by every surface that links to it
 *  (the admin recent-routing row and the booking lookup), so the path lives in
 *  one place. */
export function bookingDetailHref(bookingId: string): string {
  return `/admin/bookings/${encodeURIComponent(bookingId)}`;
}

function fmt(iso: string, tz: string): string {
  return `${formatSlotDay(iso, tz)}, ${formatSlotTime(iso, tz)}`;
}

function traceView(t: RoutingTrace, nameOf: NameResolver): BookingDetailTraceView {
  return {
    considered: t.considered.length,
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
  timeZone: string,
): BookingDetailView {
  const rescheduled =
    b.original_starts_at != null && b.original_starts_at !== b.starts_at;
  return {
    attendee: b.attendee_name || b.attendee_email || b.attendee_phone || "(no name)",
    email: b.attendee_email,
    phone: b.attendee_phone,
    status: b.status,
    when: fmt(b.starts_at, timeZone),
    ends: fmt(b.ends_at, timeZone),
    rescheduledFrom: rescheduled ? fmt(b.original_starts_at!, timeZone) : null,
    agentName: b.assigned_user_id ? nameOf(b.assigned_user_id) : "Unassigned",
    bucketCode: b.routing_trace?.bucket_code ?? null,
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
  timeZone?: string;
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
  if (!deps.canManage(deps.role)) return { kind: "forbidden" };
  if (deps.oooOnly(deps.role)) return { kind: "ooo" };
  const booking = await deps.getBooking(id, deps.orgId);
  if (!booking) return { kind: "notfound" };
  const roster = await deps.getRoster(deps.orgId);
  const view = bookingDetailView(
    booking,
    rosterNameResolver(roster),
    deps.timeZone ?? ROSTER_ZONE,
  );
  return { kind: "ok", booking, view };
}
