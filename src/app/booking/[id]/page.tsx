import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { resolveLandingCode } from "@/lib/routing/landing-code";
import { loadLandingBucketIsTest } from "@/lib/booking/landing-bucket";
import { existingCallForLanding, landingAttendee } from "@/lib/booking/service";
import { readHostColours } from "@/lib/embed/host-colours";
import { prefillFromQuery } from "@/lib/booking/book-link";
import { landingLookupId } from "@/lib/booking/landing-identity-gate";
import { programLeadTokenForLanding } from "@/lib/booking/program-lead-gate";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: { absolute: "Book a call with Pennie" } };

type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * URL-compatible booking page. Mirrors the existing scheme:
 *   /booking/{salesforceId}?xbc={code}&name&email&phone&...prefill
 * The path id is treated as an opaque Salesforce id (echoed in webhooks).
 */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  // The same catch-all as `/book` (#1908), for the same reason and by the same
  // resolver. This path was missed when that shipped: it is reached as
  // `/booking/{salesforceId}?xbc={code}`, so a lead whose Salesforce record has no
  // XBC arrives here with a blank code exactly as they do there, and refusing them
  // here would leave half the defect in place.
  //
  // #2638: the id in the path IS the lead's Salesforce id, so a blank code is
  // rescued from the lead's own `XBC__c` before the catch-all is considered, by
  // the resolver the confirm uses. A failed read throws to the error boundary.
  //
  // #3106 / #3173: what this page reads ABOUT the person named is throttled per address,
  // since a lead id is not a secret, and that includes this routing read: a blank code
  // flood would otherwise pay one Salesforce read per guessed id. Over the ceiling the
  // page shows the default route's times and leaves out the prefill and the existing
  // call notice; the id still reaches the confirm, which routes on the lead's own code.
  const requestedCode = first(sp, "xbc");
  const lookupId = await landingLookupId(id, headers);
  // No submission: the path names the lead itself (#3246).
  // #3508: started alongside the reads that do not depend on the routed code.
  // #1337: a lead who already has a call is offered the Move, which records a
  // mandatory reschedule reason chosen right there.
  // #4389: whether this lead may book the placeholder's extra times, decided here
  // through the same throttled id and handed to the client as a signed token, so no
  // later request reads program_leads for an id a stranger supplies. Never throws.
  const [resolved, horizonDays, reasonOptions, programLeadToken] = await Promise.all([
    resolveLandingCode(requestedCode, lookupId, null),
    loadBookingHorizonDays(),
    loadReasonOptions(),
    programLeadTokenForLanding(lookupId),
  ]);
  const bucketCode = resolved.code;
  // #4393: the public test bucket opens only from approved partner pages (`/book`'s origin
  // gate), so this page never had its pass. A registered PROGRAM lead's texted link may
  // open it, so the program path can be drilled on the test bucket: registering needs
  // Bidspoke's key, so nobody a stranger can name gets in. Everyone else is unchanged.
  const testPass = programLeadToken && isPublicTestBucket(bucketCode) ? currentTestPassFor(bucketCode) : null;

  // #2660: the same question `/book` asks of the same helper, so a test booking
  // reached by this route carries the test line too (L659).
  const isTest = await loadLandingBucketIsTest(bucketCode);

  const phone =
    first(sp, "phone") ||
    first(sp, "attendeePhoneNumber") ||
    first(sp, "smsReminderNumber");

  const prefill = prefillFromQuery(sp);

  const embedded = first(sp, "embed") === "1";
  const theme = first(sp, "theme") === "dark" ? ("dark" as const) : ("light" as const);
  // #2166: the id in the path IS the identity, graded as a strong match by the
  // same rule the confirm uses, so this lead is known from the first render. Asked
  // here rather than left to the confirm, where the notice would arrive one picked
  // time and one filled form too late and read as the product having forgotten
  // them. It never throws: a check that could not run shows the ordinary picker,
  // and the confirm still refuses at the end of it. Asked with the throttled `lookupId`
  // derived above.
  const landingCall = lookupId
    ? await existingCallForLanding({ salesforceId: lookupId }, { isTest })
    : null;
  // #2208: the same id that recognises them fills the form they would otherwise
  // retype. The pilot link carries none of the three in its query string, so
  // before this every recognised lead typed out a name, an email and a number
  // Slate was already holding. Every value lands in an editable field, and the
  // link's own value always wins, so nothing here is presented as a fact the lead
  // cannot correct.
  const attendee = await landingAttendee(
    { salesforceId: lookupId },
    { name: first(sp, "name"), email: first(sp, "email"), phone },
    { isTest },
  );

  return (
    <StandaloneBookerShell embedded={embedded} theme={theme}>
      <Booker
        bucketCode={bucketCode}
        requestedCode={requestedCode}
        salesforceId={id}
        attendee={attendee}
        prefill={prefill}
        embedded={embedded}
        theme={theme}
        brandColor={readHostColours({ brand: first(sp, "brand") || null, bg: null, embedded }, "/booking").brandColor}
        isTest={isTest}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        landingCall={landingCall}
        programLeadToken={programLeadToken}
        testPass={testPass}
      />
    </StandaloneBookerShell>
  );
}
