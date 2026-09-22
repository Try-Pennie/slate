import ManageBooking from "@/components/ManageBooking";
import ManageNotFound from "@/components/ManageNotFound";
import StandaloneTheme from "@/components/StandaloneTheme";
import LegalFooter from "@/components/LegalFooter";
import {
  getBookingByToken,
  getBookingAdvisorName,
  getBookingAdvisorPhoto,
} from "@/lib/booking/service";
import { loadReasonOptions } from "@/lib/booking/reason-options";

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
export const metadata = { title: "Manage your booking with Pennie" };

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
  const reasonOptions = await loadReasonOptions();
  // #1338: the advisor is read LIVE from the assignee, never a copy captured when
  // the booking was made: coverage reassignment and bulk reassign both move a
  // booking, so a stamped name would promise a lead one person and send another.
  // Null renders no name at all rather than substituting anything (L75).
  const advisorName = found
    ? await getBookingAdvisorName(found.booking.assigned_user_id ?? null)
    : null;
  // #2600: read live beside the name, for the same reason. Null on every way it
  // can be unavailable, and the component draws the initials circle then, so
  // this can never hold the page up or leave an empty frame.
  const advisorPhotoUrl = found
    ? await getBookingAdvisorPhoto(found.booking.assigned_user_id ?? null)
    : null;

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
        startsAt={found.booking.starts_at}
        status={found.booking.status}
        eventName={found.eventType.name}
        durationMin={found.eventType.duration_min}
        attendeePhone={found.booking.attendee_phone ?? null}
        attendeeEmail={found.booking.attendee_email ?? null}
        advisorName={advisorName}
        advisorPhotoUrl={advisorPhotoUrl}
        advisorRole={ADVISOR_ROLE}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        theme={theme}
      />
      {/* #1041: this page is never embedded, so it never inherits a host page's
          policies. */}
      <LegalFooter />
    </>
  );
}
