import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { AppHeader } from "@/components/AppHeader";
import { cardCls } from "@/components/ui/styles";
import AdminBookingActions from "@/components/AdminBookingActions";
import BookingHistory from "@/components/BookingHistory";
import { loadBookingDetail } from "@/lib/booking/detail";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import type { HistoryRosterUser } from "@/lib/booking/event-display";
import type { Booking } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * Per-booking detail page (#900): one home for a booking's facts, its
 * reschedule/cancel/reassign controls (reused AdminBookingActions), its history
 * (reused BookingHistory), and how it routed. Reached from the admin
 * recent-routing rows and the booking lookup. Manager+ gated and tenant-scoped
 * (a booking outside the caller's org is a 404).
 */
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

  const opts = await loadReasonOptions();
  const actionReasons = {
    reschedule: opts.reschedule.active,
    cancel: opts.cancel.active,
    reassign: opts.reassign.active,
  };

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="admin"
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-6 py-10 sm:px-8">
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

        <section className={cardCls}>
          <h2 className="mb-3 text-sm font-semibold">History</h2>
          <BookingHistory bookingId={booking.id} />
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Routing</h2>
          {view.trace ? (
            <div className="space-y-1 text-sm text-fg-muted">
              <div>
                {view.trace.considered} agent{view.trace.considered === 1 ? "" : "s"} considered
                {view.trace.fallbackApplied ? " · fallback used" : ""}
              </div>
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
      </main>
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
