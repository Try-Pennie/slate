import ManageBooking from "@/components/ManageBooking";
import ManageNotFound from "@/components/ManageNotFound";
import StandaloneTheme from "@/components/StandaloneTheme";
import LegalFooter from "@/components/LegalFooter";
import {
  bookingDetailExtras,
  getBookingByToken,
  getBookingAdvisorName,
  getBookingAdvisorPhoto,
  getBookingCallingNumber,
} from "@/lib/booking/service";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";
import { rescheduleTimesFrom } from "@/lib/booking/reschedule-times-url";
import { manageHref, rebookHref } from "@/lib/booking/book-link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The advisor's lead-facing title, shown under their name on the manage page.
 *
 * Taken from the wording Pennie already uses with leads rather than invented: the
 * configured event type is named "Senior Loan Advisor Call" and describes
 * "Twenty minutes with a senior advisor". The agent record carries only an
 * internal Salesforce classification ("Sales" for 96 of 97 agents), which is not
 * something to show a customer. Change it here if advisors are retitled; #1335
 * is where booker-facing copy becomes admin-editable.
 */
const ADVISOR_ROLE = "Senior Loan Advisor";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: { absolute: "Manage your booking with Pennie" } };

export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  // Same contract as /book: anything other than `theme=dark` renders light.
  const theme = sp.theme === "dark" ? ("dark" as const) : ("light" as const);
  const found = await getBookingByToken(token);
  // #3672: the booking API moved this call to another bucket, which cancelled the
  // booking this token names and made a new one under a new token. The lookup followed
  // to it, so open THAT page: every action on it then acts on the call the lead has.
  if (found?.followedToToken) redirect(manageHref({ manageToken: found.followedToToken, theme }));
  const reasonOptions = await loadReasonOptions();
  // #1338: the advisor is read LIVE from the assignee, never a copy captured when
  // the booking was made: coverage reassignment and bulk reassign both move a
  // booking, so a stamped name would promise a lead one person and send another.
  // Null renders no name at all rather than substituting anything (L75).
  //
  // The photo is read live BESIDE the name (#2600) for the same reason, and
  // TOGETHER with it rather than after it: they are two independent reads keyed
  // on the same assignee, so awaiting them in turn spent two round trips to
  // answer one question, on a page a customer is waiting for. Null on every way
  // the photo can be unavailable, and the component draws the initials circle
  // then, so it can never hold the page up or leave an empty frame.
  const assignedUserId = found?.booking.assigned_user_id ?? null;
  // #1334: the number the call will come FROM, read beside the advisor for the same
  // reason the photo is: independent reads, one round trip. Only for a call still to
  // come, since a call that is over has nothing left to screen. Null on every way it
  // can be unknown, under a deadline, so it can never hold the page up.
  const live = found?.booking.status === "confirmed" || found?.booking.status === "rescheduled";
  const [advisorName, advisorPhotoUrl, callingNumber] = found
    ? await Promise.all([
        getBookingAdvisorName(assignedUserId),
        getBookingAdvisorPhoto(assignedUserId),
        live ? getBookingCallingNumber(found.booking) : Promise.resolve(null),
      ])
    : [null, null, null];

  // #706: paint the theme at the document root so dark renders don't leave a
  // beige gutter behind the content card. Always standalone (never embedded).
  if (!found) {
    return (
      <>
        <StandaloneTheme theme={theme} />
        <ManageNotFound theme={theme} />
        <LegalFooter />
      </>
    );
  }

  return (
    <>
      <StandaloneTheme theme={theme} />
      <ManageBooking
        token={token}
        bucketCode={found.bucket.code}
        // #2666: the manage token already authorises this viewer, so a test
        // booking's page mints the pass its reschedule panel needs to read the
        // public test bucket's times. Null for every real booking.
        testPass={currentTestPassFor(found.bucket.code)}
        // #2827: a call booked through an advisor's own link can only move to a
        // time that advisor can take, so its picker reads that advisor's times.
        rescheduleTimesFrom={rescheduleTimesFrom(found.booking)}
        // #2982: "Book a new time" opens the rebook booker under THIS page's own
        // path, which reads the Lead id, details and source server side by the
        // same token, so no contact data rides on a URL; this page's theme carries.
        rebookHref={rebookHref({ bucketCode: found.bucket.code, manageToken: token, theme })}
        startsAt={found.booking.starts_at}
        status={found.booking.status}
        eventName={found.eventType.name}
        durationMin={found.eventType.duration_min}
        attendeePhone={found.booking.attendee_phone ?? null}
        attendeeEmail={found.booking.attendee_email ?? null}
        callingNumber={callingNumber}
        advisorName={advisorName}
        advisorPhotoUrl={advisorPhotoUrl}
        advisorRole={ADVISOR_ROLE}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        theme={theme}
        // #2660: read off the booking's own bucket, the one place the flag lives.
        isTest={found.bucket.is_test}
        // #2165: the add to calendar links, from the one builder the confirm and
        // the booking lookup use (#2643). Null on a cancelled call.
        calendarLinks={bookingDetailExtras(found.booking).calendarLinks}
      />
      {/* #1041: this page is never embedded, so it never inherits a host page's
          policies. */}
      <LegalFooter />
    </>
  );
}
