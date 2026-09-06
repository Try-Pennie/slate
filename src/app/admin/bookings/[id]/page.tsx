import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { cardCls } from "@/components/ui/styles";
import AdminBookingActions from "@/components/AdminBookingActions";
import BookingHistory from "@/components/BookingHistory";
import { bookingIsActionable, loadBookingDetail } from "@/lib/booking/detail";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import type { BookingEventView, HistoryRosterUser } from "@/lib/booking/event-display";
import { listBookingHistory } from "@/lib/booking/history";
import { log } from "@/lib/log";

/**
 * How many considered agents to name before summarising the rest (#1943).
 *
 * Routing can weigh most of an 84 agent roster, and 84 names in a card is not an
 * answer to "which agents". The count above the list still says how many there
 * were, so nothing is hidden, only summarised.
 */
const CONSIDERED_SHOWN = 12;
import type { Booking } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * Per-booking detail page (#900): one home for a booking's facts, its
 * reschedule/cancel/reassign controls (reused AdminBookingActions), its history
 * (reused BookingHistory), and how it routed. Reached from the admin
 * recent-routing rows and the booking lookup. Manager+ gated and tenant-scoped
 * (a booking outside the caller's org is a 404).
 */
// nav-ok: a booking lookup result opens this, so no navigation entry can name it: the address contains the booking's id
export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await currentUser();
  if (!me) redirect("/login");

  const db = supabaseAdmin();
  const result = await loadBookingDetail(id, {
    role: me.role,
    orgId: me.org_id,
    canManage: canManageAgents,
    oooOnly: oooOnlyFor,
    // #1629: a null booking here is `notfound()`, so a swallowed error told an
    // admin looking up a booking that it does not exist. On the surface somebody
    // opens because they suspect a booking went missing, that is the one answer
    // that must be true when it is given.
    async getBooking(bookingId, orgId) {
      const data = unwrap(
        await db
          .from("bookings")
          .select("*")
          .eq("id", bookingId)
          .eq("org_id", orgId)
          .maybeSingle(),
        "booking detail row",
      );
      return (data as Booking | null) ?? null;
    },
    // An empty roster leaves every actor in the history rendered as a bare id,
    // so the trail stops naming who did what.
    async getRoster(orgId) {
      const data = unwrap(
        await db.from("users").select("id,name,email").eq("org_id", orgId),
        "booking detail roster",
      );
      return (data ?? []) as HistoryRosterUser[];
    },
  });

  if (result.kind === "forbidden") {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view bookings.
      </main>
    );
  }
  if (result.kind === "ooo") redirect("/admin/ooo");
  if (result.kind === "notfound") notFound();
  const { booking, view } = result;

  // #1943: the history, read HERE. It was a client fetch behind a toggle, and
  // taking the toggle away honestly meant taking the fetch with it. `null` is
  // "could not be read", which is a different screen from "nothing has changed".
  let history: BookingEventView[] | null = null;
  try {
    history = await listBookingHistory(booking.id, me.org_id);
  } catch (err) {
    log.error("booking-detail", { msg: "history unreadable", booking_id: booking.id }, err);
    history = null;
  }

  const opts = await loadReasonOptions();
  const actionReasons = {
    reschedule: opts.reschedule.active,
    cancel: opts.cancel.active,
    reassign: opts.reassign.active,
  };

  return (
    <>
      <>
        <a
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          &larr; Back to admin
        </a>

        <section className={cardCls}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-lg font-semibold">{view.attendee}</h1>
            <span className="capitalize text-sm text-fg-muted">{view.status}</span>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Email" value={view.email} />
            <Fact label="Phone" value={view.phone} />
            <Fact label="When" value={view.when} />
            <Fact label="Ends" value={view.ends} />
            {view.rescheduledFrom && <Fact label="Originally" value={view.rescheduledFrom} />}
            <Fact label="Agent" value={view.agentName} />
            <Fact label="Bucket" value={view.bucketCode} />
          </dl>
        </section>

        {/* #1943: no card at all when nothing is actionable. Dan: "what does
            actions canceled mean? I can see it was canceled from the history."
            It was a card headed Actions containing the single word Cancelled,
            which is the component saying "there are none" by printing a status
            the page already states twice. An empty Actions card is not
            information, so it goes, and `completed` takes the same route since
            it hit the same branch and read just as oddly. */}
        {bookingIsActionable(booking.status) && (
        <section className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold">Actions</h2>
          <AdminBookingActions
            bookingId={booking.id}
            bucketCode={view.bucketCode}
            status={booking.status}
            currentAgentId={booking.assigned_user_id}
            reasonOptions={actionReasons}
          />
        </section>
        )}

        <section className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold">History</h2>
          {/* #1943: read here rather than fetched from the browser on a toggle.
              `null` means the read FAILED, which the component says out loud
              rather than drawing as "no changes recorded". */}
          <BookingHistory events={history} />
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Routing</h2>
          {view.trace ? (
            <div className="space-y-1 text-sm text-fg-muted">
              {/* #1943: WHO was considered, not how many. The ids were already
                  on the page and it printed their length. Long pools are capped
                  rather than dumped: routing can weigh most of an 84 agent
                  roster, and the count still says how many there were. */}
              <div>
                {view.trace.considered.length} agent
                {view.trace.considered.length === 1 ? "" : "s"} considered
                {view.trace.fallbackApplied ? " \u00b7 fallback used" : ""}
              </div>
              {view.trace.considered.length > 0 && (
                <div className="text-fg">
                  {view.trace.considered.slice(0, CONSIDERED_SHOWN).join(", ")}
                  {view.trace.considered.length > CONSIDERED_SHOWN &&
                    ` and ${view.trace.considered.length - CONSIDERED_SHOWN} more`}
                </div>
              )}
              {view.trace.reassignments.map((r, i) => (
                <div key={i} className="text-pennie-blue dark:text-pennie-sky">
                  reassigned {r.from} &rarr; {r.to}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">No routing trace recorded.</p>
          )}
        </section>
      </>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-fg">{value || "not set"}</dd>
    </div>
  );
}
