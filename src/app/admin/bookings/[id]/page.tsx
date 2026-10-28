import type { ReactNode } from "react";
import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import { bucketHeading, bucketShownAs } from "@/lib/availability/pool-label";
import { consoleHiddenFor } from "@/lib/env";
import { consoleHomeFor } from "@/lib/admin/nav";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { cardCls } from "@/components/ui/styles";
import AdminBookingActions from "@/components/AdminBookingActions";
import { TestMark } from "@/components/TestModeBand";
import BookingHistory from "@/components/BookingHistory";
import ViewerTime from "@/components/ViewerTime";
import { bookingIsActionable, loadBookingDetail } from "@/lib/booking/detail";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { rescheduleTimesFrom } from "@/lib/booking/reschedule-times-url";
import type { BookingEventView, HistoryRosterUser } from "@/lib/booking/event-display";
import { listBookingHistory } from "@/lib/booking/history";
import { log } from "@/lib/log";
import DemotionMoveBack from "@/components/DemotionMoveBack";
import type { DemotionMoveView } from "@/lib/booking/demotion-revert";
import { loadDemotionMoveView } from "@/lib/booking/demotion-revert-store";

/**
 * How many considered agents to name before summarising the rest (#1943).
 *
 * Routing can weigh most of an 84 agent roster, and 84 names in a card is not an
 * answer to "which agents". The count above the list still says how many there
 * were, so nothing is hidden, only summarised.
 */
const CONSIDERED_SHOWN = 12;
import type { Booking } from "@/lib/db/types";

export const metadata = { title: "Booking" };

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
    oooOnly: consoleHiddenFor,
    // #1629: a null booking here is `notfound()`, so a swallowed error told an
    // admin looking up a booking that it does not exist. On the surface somebody
    // opens because they suspect a booking went missing, that is the one answer
    // that must be true when it is given.
    // #2660: the bucket's flag rides along on the row (`bookings` carries none of
    // its own), read in the same query and lifted off below, so a stranger's test
    // booking on the public test bucket is marked on the one page that carries
    // the controls to move it.
    async getBooking(bookingId, orgId) {
      const data = unwrap(
        await db
          .from("bookings")
          .select("*, buckets!inner(is_test, name, code)")
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
        // any-advisor-ok: names every actor and advisor in the history, the
        // placeholder and the test advisors included.
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
  // #2660: the joined flag, off the row the read above returned.
  const joined = (booking as Booking & { buckets?: { is_test?: boolean; name?: string | null } | null })
    .buckets;
  const isTest = joined?.is_test === true;
  // The stored name, for a manager reading a bucket outside the routing matrix.
  const bucketName = joined?.name ?? null;
  const showCodes = canEditOrgSettings(me.role);

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

  // #3615: whether an automatic demotion reroute moved this call, and whether it can go back.
  // `undefined` is "no automatic move", `null` is "could not be read", which says so rather
  // than hiding the undo (L10).
  let demotionMove: DemotionMoveView | null | undefined;
  try {
    demotionMove = (await loadDemotionMoveView(booking, me.org_id)) ?? undefined;
  } catch (err) {
    log.error("booking-detail", { msg: "demotion move unreadable", booking_id: booking.id }, err);
    demotionMove = null;
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
          href={consoleHomeFor(me.role)}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          &larr; {consoleHomeFor(me.role) === "/admin" ? "Back to admin" : "Back to roster"}
        </a>

        <section className={cardCls}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              {isTest && <TestMark />}
              {view.attendee}
            </h1>
            <span className="capitalize text-sm text-fg-muted">{view.status}</span>
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Email" value={view.email} />
            <Fact label="Phone" value={view.phone} />
            {/* #1916: the viewer's zone, labelled. The view carries instants
                because this page renders on the server, which cannot know who
                is reading. */}
            <Fact label="When" value={<ViewerTime iso={view.startsAt} />} />
            <Fact label="Ends" value={<ViewerTime iso={view.endsAt} />} />
            {view.rescheduledFrom && (
              <Fact label="Originally" value={<ViewerTime iso={view.rescheduledFrom} />} />
            )}
            <Fact label="Agent" value={view.agentName} />
            {/* 2026-10-02: a manager reads the pool in words, never the code;
                an admin keeps the code. The code still reaches the actions
                below, where it only builds a URL and is never displayed. */}
            <Fact
              label={bucketHeading(showCodes)}
              value={bucketShownAs(view.bucketCode, { showCodes, storedName: bucketName })}
            />
            <Fact label="Source" value={view.source} />
          </dl>
        </section>

        {/* #3615: an automatic demotion reroute, said where the call's advisor is, with its undo.
            No card when no sweep moved this call. */}
        {demotionMove !== undefined && (
          <section className={cardCls}>
            <h2 className="mb-3 text-sm font-semibold">Moved automatically</h2>
            {demotionMove === null ? (
              <p className="text-sm text-fg-muted">
                Slate could not check whether this call was moved automatically. Reload the page to try again.
              </p>
            ) : (
              <DemotionMoveBack bookingId={booking.id} view={demotionMove} />
            )}
          </section>
        )}

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
            // #2827: a call booked through an advisor's own link can only move to
            // a time that advisor can take, so its picker reads that advisor's times.
            rescheduleTimesFrom={rescheduleTimesFrom(booking)}
            // #2666: staff are already authorised, so a test booking's panel is
            // handed the pass its reschedule read needs. Null for a real booking.
            testPass={view.bucketCode ? currentTestPassFor(view.bucketCode) : null}
            leadTimeZone={booking.timezone}
            status={booking.status}
            currentAgentId={booking.assigned_user_id}
            reasonOptions={actionReasons}
            showCodes={showCodes}
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

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-fg">{value || "not set"}</dd>
    </div>
  );
}
