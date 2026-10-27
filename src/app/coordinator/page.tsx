import { redirect } from "next/navigation";
import { coordinatorDeskUser } from "@/lib/auth";
import StandaloneTheme from "@/components/StandaloneTheme";
import { PageShell } from "@/components/ui/PageShell";
import { CoordinatorBooking } from "@/components/coordinator/CoordinatorBooking";
import { readDesignFixture } from "@/lib/admin/design-fixture-read";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { initialPageState } from "@/lib/coordinator/booking-page";
import { coordinatorBookingFrame, type CoordinatorBookingDesignFixture } from "@/lib/coordinator/booking-page-fixture";

export const metadata = { title: "Book a call" };

export const dynamic = "force-dynamic";

/**
 * The coordinator booking page (#4205, Phase 7 of milestone 75), settled as
 * docs/design/coordinator-booking.html: a scheduling coordinator pastes the customer's
 * Salesforce Lead, checks their time zone, picks one of the days and times Slate offers,
 * and books or moves the call, on the placeholder advisor when nobody is free.
 *
 * WHO: a coordinator, or an admin who trains them (`coordinatorDeskUser`). Anybody else,
 * signed out or signed in as an advisor or manager, is sent to sign in, where a
 * coordinator account is the way in (the gate `scripts/test-staff-page-access.ts` holds
 * every staff page to). Both server actions check the role themselves, so this gate is
 * presentation, not the control. WHOSE DATA: the customer whose Lead was pasted, read
 * from Salesforce on every lookup and every booking.
 *
 * `?frame=` draws one of the design's frames from its committed fixture, so the design
 * match score compares like with like; it answers only when the e2e run sets the flag and
 * the request is to this machine (`readDesignFixture`), and only after the gate.
 */
export default async function CoordinatorPage({ searchParams }: { searchParams: Promise<{ frame?: string }> }) {
  const me = await coordinatorDeskUser();
  if (!me) redirect("/login");
  const sp = await searchParams;

  const fixture = await readDesignFixture<CoordinatorBookingDesignFixture>(sp.frame, "coordinator-booking");
  if (fixture && sp.frame) {
    const f = coordinatorBookingFrame(fixture, sp.frame);
    return (
      <>
        {/* Outside <main>: the design's checks read main's words, and a script's text is words. */}
        <StandaloneTheme theme={f.theme} />
        <PageShell width="narrow">
          <CoordinatorBooking initial={f.state} reasons={f.reasons} fixedNowMs={f.nowMs} />
        </PageShell>
      </>
    );
  }

  // The product's reschedule reasons a person may choose, as the manage page offers them;
  // the server action validates the one sent against the same list.
  const reasons = (await loadReasonOptions()).reschedule.selectable.map((r) => ({ code: r.code, label: r.label }));
  return (
    <PageShell width="narrow">
      <CoordinatorBooking initial={initialPageState()} reasons={reasons} />
    </PageShell>
  );
}
