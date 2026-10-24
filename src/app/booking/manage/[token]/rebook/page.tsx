import type { Metadata } from "next";
import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import ManageNotFound from "@/components/ManageNotFound";
import StandaloneTheme from "@/components/StandaloneTheme";
import LegalFooter from "@/components/LegalFooter";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { redirect } from "next/navigation";
import {
  existingCallForLanding,
  getBookingByToken,
  landingAttendee,
  rebookRowForToken,
} from "@/lib/booking/service";
import { REBOOK_ROUTE, manageHref, rebookEntry } from "@/lib/booking/book-link";
import { resolveLandingCode } from "@/lib/routing/landing-code";
import { loadLandingBucketIsTest } from "@/lib/booking/landing-bucket";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";

export const dynamic = "force-dynamic";

// Lead-facing: the brand is Pennie; Slate stays internal. The address carries the
// manage token, a credential that can cancel and move the call, so the page is
// kept out of search and its URL out of any Referer but this site's own.
export const metadata: Metadata = {
  title: { absolute: "Book a call with Pennie" },
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * "Book a new time" after a call is over (#2982).
 *
 * Served UNDER the manage path the lead is already on, and resolved by the same
 * token and the same security model as the manage page, so it exposes nothing
 * the manage page does not. The booking's Lead id, the lead's details and the
 * page it was booked from fill the booker server side: none of it rides on a URL,
 * and the token never reaches the public `/book` page that host pages frame.
 *
 * Four outcomes of the lookup, each drawn differently:
 * - replaced (#3672): a booking the API moved to another bucket. The manage page of
 *   the booking that replaced it opens instead, or not found if that one cannot be
 *   read, never a booker that would book the lead a second call.
 * - found: the booking's own bucket, prefilled.
 * - absent (no such booking, or one whose page offers no rebook): the manage
 *   page's own not found state, never another booking and never a booker.
 * - failed (a read error, a timeout, an unreadable row): the bucket the link
 *   named, with nothing prefilled, since the lead can still book.
 */
export default async function RebookPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<SP>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  // Same contract as the manage page: anything other than `theme=dark` is light.
  const theme = first(sp, "theme") === "dark" ? ("dark" as const) : ("light" as const);

  const lookup = await rebookRowForToken(token);
  // #3672: the booking API moved this call to another bucket. A rebook here would book
  // the lead a second call in the old bucket, so open the booking that replaced it,
  // followed to the end of the chain by the lookup the manage page uses.
  const replacement = lookup.kind === "replaced" ? await getBookingByToken(token) : null;
  if (replacement) redirect(manageHref({ manageToken: replacement.booking.manage_token, theme }));
  if (lookup.kind === "absent" || lookup.kind === "replaced") {
    return (
      <>
        <StandaloneTheme theme={theme} />
        <ManageNotFound theme={theme} />
        <LegalFooter />
      </>
    );
  }

  const entry = lookup.kind === "found" ? rebookEntry(lookup.row) : null;
  const requestedCode = entry ? entry.requestedCode : first(sp, "xbc");
  const salesforceId = entry?.externalId ?? null;
  // The resolver `/book` uses, so a rebook lands on the pool a fresh link would.
  // landing-identity-ok: the id comes off the token's own booking, not the link
  // No submission: a rebook carries the booking's own lead id, or nothing (#3246).
  const bucketCode = (await resolveLandingCode(requestedCode, salesforceId, null)).code;
  const isTest = await loadLandingBucketIsTest(bucketCode);
  // #2666: the token authorises this viewer exactly as it does on the manage page,
  // so a test booking's rebook mints the pass its booker needs. A failed lookup
  // proved nothing about the token, so it mints none.
  const testPass = entry ? currentTestPassFor(bucketCode) : null;
  const horizonDays = await loadBookingHorizonDays();
  const reasonOptions = await loadReasonOptions();
  // The id here is read off the booking an unguessable manage token names, never taken
  // from the link, so it cannot be walked like a landing page's (#3106).
  const landingCall = salesforceId
    ? // landing-identity-ok: the id comes off the token's own booking, not the link
      await existingCallForLanding({ salesforceId }, { isTest })
    : null;
  // landing-identity-ok: the id comes off the token's own booking, not the link
  const attendee = await landingAttendee(
    { salesforceId },
    entry?.link ?? { name: "", email: "", phone: "" },
    { isTest },
  );

  return (
    <StandaloneBookerShell embedded={false} theme={theme}>
      <ClientErrorBeacon page={REBOOK_ROUTE} bucketCode={bucketCode} />
      <Booker
        bucketCode={bucketCode}
        requestedCode={requestedCode}
        salesforceId={salesforceId}
        attendee={attendee}
        prefill={entry?.prefill ?? {}}
        embedded={false}
        theme={theme}
        isTest={isTest}
        testPass={testPass}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        landingCall={landingCall}
      />
    </StandaloneBookerShell>
  );
}
