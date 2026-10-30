import { redirect } from "next/navigation";
import { browserSignInPath } from "@/lib/auth/browser-sign-in-path";
import { coordinatorDeskUser } from "@/lib/auth";
import StandaloneTheme from "@/components/StandaloneTheme";
import { PageShell } from "@/components/ui/PageShell";
import { CoordinatorBooking } from "@/components/coordinator/CoordinatorBooking";
import { readDesignFixture } from "@/lib/admin/design-fixture-read";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { initialPageState } from "@/lib/coordinator/booking-page";
import { coordinatorBookingFrame, type CoordinatorBookingDesignFixture, type CoordinatorBookingFrame } from "@/lib/coordinator/booking-page-fixture";
import { callMeNowFrame, isCallMeNowFrame, type CallMeNowDesignFixture } from "@/lib/coordinator/call-me-now-fixture";

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
 * the request is to this machine (`readDesignFixture`), and only after the gate. The live
 * transfer design (#4380, docs/design/coordinator-call-me-now.html) has frames of its own,
 * drawn over the booking design's "Sam found" from both designs' fixtures.
 */
export default async function CoordinatorPage({ searchParams }: { searchParams: Promise<{ frame?: string }> }) {
  const me = await coordinatorDeskUser();
  if (!me) redirect(await browserSignInPath());
  const sp = await searchParams;

  const f = await designFrame(sp.frame);
  if (f) {
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

/** The design frame `?frame=` names, from the committed fixtures, or null to draw the real page. */
async function designFrame(frame: string | undefined): Promise<CoordinatorBookingFrame | null> {
  const booking = await readDesignFixture<CoordinatorBookingDesignFixture>(frame, "coordinator-booking");
  if (!booking || !frame) return null;
  if (!isCallMeNowFrame(frame)) return coordinatorBookingFrame(booking, frame);
  const callMeNow = await readDesignFixture<CallMeNowDesignFixture>(frame, "coordinator-call-me-now");
  return callMeNow ? callMeNowFrame(booking, callMeNow, frame) : null;
}
