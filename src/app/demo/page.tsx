import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { loadLandingBucketIsTest } from "@/lib/booking/landing-bucket";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { readBookEntryQuery } from "@/lib/booking/book-link";
import { attendeeForLanding } from "@/lib/booking/known-lead";
import { resolveLandingCode } from "@/lib/routing/landing-code";
import { demoVisit, newDemoSuffix } from "@/lib/embed/demo-visit";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";

export const dynamic = "force-dynamic";
// The booker unchanged, so the page carries the booker's own title. Kept out of
// search: the link is sent to people, not found.
export const metadata = {
  title: { absolute: "Book a call with Pennie" },
  robots: { index: false, follow: false },
};

type SP = Record<string, string | string[] | undefined>;

/** A number in [0, 1) from the platform's secure generator, which the Worker has. */
function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

/**
 * The demo link (#3424): the booker, for somebody outside Pennie to see and use.
 *
 * It books the demo bucket, a test bucket on the test agent's calendar, so nothing
 * reaches a real advisor, Regal or a text, and every screen carries the demo band.
 * Its bookings cancel themselves 30 minutes after they are made (the complete
 * lane, `demo-auto-cancel.ts`).
 *
 * Three things `/book` decides that this page decides differently, each on purpose:
 *
 *  - It is opened directly, never from a host page, so there is no Referer to judge.
 *    The page itself is what grants the demo bucket, and it mints the pass the
 *    public test routes demand. `/book` refuses the demo code from every website,
 *    so this page is the one way in.
 *  - Every visit is a made up person of its OWN (`demo-visit.ts`), complete, so the
 *    visitor only picks a time and two visitors never read as one person to the
 *    one call per person check.
 *  - Nothing about a lead is read: the person is invented here, so there is no
 *    Salesforce lookup, no existing call to find, and no throttle to spend.
 */
export default async function DemoPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const themeParam = Array.isArray(sp.theme) ? sp.theme[0] : sp.theme;
  const theme = themeParam === "dark" ? ("dark" as const) : ("light" as const);

  const visit = demoVisit(newDemoSuffix(secureRandom));
  // Through the reader `/book` uses, so the prefill and the attendee are shaped
  // exactly as a host page link's would be.
  const entry = readBookEntryQuery(visit.query);

  // Through the one landing resolver every booker entry uses, so the code drawn is
  // the code the confirm will route. A public test code resolves to itself, and
  // with no lead id it reads nothing.
  // landing-identity-ok: no lead is named; the id is invented on this page, so there is nothing to throttle.
  const bucketCode = (await resolveLandingCode(entry.requestedCode, "", null)).code;
  const isTest = await loadLandingBucketIsTest(bucketCode);
  const horizonDays = await loadBookingHorizonDays();
  const reasonOptions = await loadReasonOptions();

  return (
    <StandaloneBookerShell embedded={false} theme={theme}>
      <ClientErrorBeacon page="/demo" bucketCode={bucketCode} />
      <Booker
        bucketCode={bucketCode}
        requestedCode={entry.requestedCode}
        salesforceId={visit.salesforceId}
        attendee={attendeeForLanding(entry.link, null)}
        prefill={entry.prefill}
        embedded={false}
        theme={theme}
        isTest={isTest}
        testPass={currentTestPassFor(bucketCode)}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        landingCall={null}
      />
    </StandaloneBookerShell>
  );
}
