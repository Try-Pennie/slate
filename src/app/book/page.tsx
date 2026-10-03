import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { loadLandingBucketIsTest } from "@/lib/booking/landing-bucket";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { resolveLandingCode } from "@/lib/routing/landing-code";
import { existingCallForLanding, landingAttendee } from "@/lib/booking/service";
import { DEFAULT_BRAND_COLOR } from "@/lib/brand-label";
import { headers } from "next/headers";
import { TestAccessRefused } from "@/components/TestAccessRefused";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { judgeTestOrigin, testOriginRefusalSentence } from "@/lib/embed/test-pass";
import { currentTestPassFor } from "@/lib/embed/test-pass-gate";
import { embedTestOrigins, embedTestPassSecret } from "@/lib/env";
import { log } from "@/lib/log";
import { readBookEntryQuery } from "@/lib/booking/book-link";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: { absolute: "Book a call with Pennie" } };

type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * Query-only booking entry for the embed / cal-style links, where there's no
 * path segment: the bucket comes from `xbc` and the external (Salesforce)
 * record id from `external_id` (rather than the path, as on /booking/[id]).
 * Everything else is prefill. Used by widget.js for `data-cal-link` clicks.
 */
export default async function BookEntry({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  // #2982: the query is read through the one shared reader of this page's URL
  // contract (`book-link.ts`), beside the link Slate builds for a lead booking
  // again, which deliberately does NOT come here: it carries a manage token,
  // and this public page is framed by host pages and their scripts.
  const entry = readBookEntryQuery(sp);

  // A blank or unreadable code is ROUTED, not refused (#1908). cal.com catches
  // every one with its own catch-all to the Low pool, and that rule carries about
  // 2 percent of all bookings today, so refusing them turns a working lead into a
  // dead end at cutover. The lead sees an ordinary booker: the routing is our
  // problem, not something they can act on.
  //
  // #2638: when the link carries no routable code but names the lead
  // (`external_id`, the 00Q Lead id), the lead's own `XBC__c` is read from
  // Salesforce and routed on, by the same resolver the confirm uses, so the times
  // shown and the pool booked agree. A failed read throws to the error boundary,
  // which offers a retry, rather than showing the catch-all's times.
  const requestedCode = entry.requestedCode;
  const resolved = await resolveLandingCode(requestedCode, entry.externalId);
  const bucketCode = resolved.code;
  const embedded = first(sp, "embed") === "1";
  const theme = first(sp, "theme") === "dark" ? ("dark" as const) : ("light" as const);

  // #2666: the public test bucket opens only for a page on an approved website.
  // The Referer here is the iframe document's own request, which a host sending
  // `strict-origin-when-cross-origin` fills with its ORIGIN. That is a convenience
  // gate, not authentication (anything that is not a browser can send any Referer
  // it likes): it keeps the test path off every website nobody approved. Judged
  // BEFORE any read about the lead, so a refused page reads nothing. An approved
  // page is handed a short lived pass the Booker sends on every call it makes.
  let testPass: string | null = null;
  if (isPublicTestBucket(bucketCode)) {
    const secret = embedTestPassSecret();
    const gate = judgeTestOrigin({
      referer: (await headers()).get("referer"),
      approvedOrigins: embedTestOrigins(),
      secret,
    });
    if (!gate.allow) {
      // The reason CLASS and the origin that asked, never a pass.
      log.warn("embed-test", { msg: "refused a test booking page", reason: gate.reason, origin: gate.origin });
      return (
        <StandaloneBookerShell embedded={embedded} theme={theme}>
          <TestAccessRefused sentence={testOriginRefusalSentence(gate.reason, gate.origin)} />
        </StandaloneBookerShell>
      );
    }
    testPass = currentTestPassFor(bucketCode);
  }

  // #2660: the PUBLIC test bucket passes through the resolver above, and this is
  // where the booker learns it is drawing a test booking, so every screen it
  // reaches carries the test line. The refusal that used to sit here (a sentence
  // saying the link was unavailable) is gone with its branch: after the resolver
  // change no reachable code produces a HIDDEN test bucket on this page, since a
  // non XBC code is rescued to the Low pool and an XBC code is a real bucket, so
  // the branch was dead code guarded by a fixture production never produced (L29,
  // L84). A hidden bucket is still refused, at the confirm (#2667).
  const isTest = await loadLandingBucketIsTest(bucketCode);
  const horizonDays = await loadBookingHorizonDays();
  // #1337: when a lead already has a call, the booker offers to MOVE it, and a
  // reschedule records a mandatory reason (Dan, 2026-08-07: ask the lead), so the
  // live option set has to reach the client the same way the manage page gets it.
  const reasonOptions = await loadReasonOptions();
  // #2166: `/book?external_id=` carries the same identity `/booking/{id}` does, and
  // is graded the same way, so a lead who arrives by either route is told about the
  // call they have before they pick a time. A link with NO id identifies nobody,
  // this resolves to null, and the confirm check stays the first moment anybody can
  // be recognised.
  //
  // It is asked as `salesforceId`, which is the field the CONFIRM sends for this
  // same value (`Booker` takes `external_id` into its `salesforceId` prop and posts
  // it under that name), so both ends grade the identical identity. Since #2663 a
  // strong id matches either id column, so this also recognises a booking an API
  // caller made with only `externalId`.
  const externalId = entry.externalId;
  // Asked in the WORLD of the bucket being landed on (#2660): a tester who pastes
  // a real lead's id into a test link is never shown that lead's call, and a real
  // lead never meets a tester's.
  const landingCall = externalId
    ? await existingCallForLanding({ salesforceId: externalId }, { isTest })
    : null;

  const prefill = entry.prefill;

  // #2208: through the SAME resolver `/booking/{id}` uses, because both routes
  // grade the same identity and a second copy of this rule would let one of them
  // go on asking a recognised lead to retype what Slate holds (L613).
  const attendee = await landingAttendee(
    { salesforceId: externalId },
    entry.link,
    { isTest },
  );

  return (
    <StandaloneBookerShell embedded={embedded} theme={theme}>
      {/* #1368: a bundle that throws before the customer can submit produces no
          request at all, so every server side detector stays green while nobody
          can book. This is the only signal for that. It mounts inside Slate's own
          document, which covers the standalone page and the embed iframe alike. */}
      <ClientErrorBeacon page="/book" bucketCode={bucketCode} />
      <Booker
        bucketCode={bucketCode}
        requestedCode={requestedCode}
        salesforceId={externalId}
        attendee={attendee}
        prefill={prefill}
        embedded={embedded}
        theme={theme}
        brandColor={first(sp, "brand") || (embedded ? DEFAULT_BRAND_COLOR : undefined)}
        parentOrigin={first(sp, "parentOrigin") || undefined}
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
