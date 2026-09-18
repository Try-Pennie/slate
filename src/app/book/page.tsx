import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { resolveRequestedCode } from "@/lib/routing/catchall";
import { existingCallForLanding, landingAttendee } from "@/lib/booking/service";
import { DEFAULT_BRAND_COLOR } from "@/lib/brand-label";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: "Book a call with Pennie" };

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

  // A blank or unreadable code is ROUTED, not refused (#1908). cal.com catches
  // every one with its own catch-all to the Low pool, and that rule carries about
  // 2 percent of all bookings today, so refusing them turns a working lead into a
  // dead end at cutover. The lead sees an ordinary booker: the routing is our
  // problem, not something they can act on.
  const requestedCode = first(sp, "xbc");
  const resolved = resolveRequestedCode(requestedCode);
  const bucketCode = resolved.code;

  // #2542: `unwrap`, not a swallowed read. `bucketRow?.is_test` reads a FAILED
  // query as "not a test bucket", so an unreadable `buckets` table renders the
  // public booker for a SMOKE code (#396) instead of refusing it. A real read
  // error is a broken deploy and belongs on the screen as one.
  const bucketRow = unwrap(
    await supabaseAdmin()
      .from("buckets")
      .select("org_id, is_test")
      .eq("code", bucketCode)
      .maybeSingle(),
    "book page bucket",
  );
  // A synthetic test bucket (#396) has no public booking page — treat its code
  // like a misconfigured link rather than rendering an (empty) Booker for it.
  if (bucketRow?.is_test) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-8">
        <p className="max-w-md text-sm text-fg-muted">
          This booking link is not available.
        </p>
      </main>
    );
  }
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
  // it under that name), so both ends grade the identical identity. Asking it as
  // `externalId` here would query a different column from the one the booking is
  // eventually written with, and the two checks would disagree about the same lead.
  const externalId = first(sp, "external_id") || null;
  const landingCall = externalId
    ? await existingCallForLanding({ salesforceId: externalId })
    : null;

  const phone =
    first(sp, "phone") ||
    first(sp, "attendeePhoneNumber") ||
    first(sp, "smsReminderNumber");

  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    prefill[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }

  const embedded = first(sp, "embed") === "1";
  const theme = first(sp, "theme") === "dark" ? ("dark" as const) : ("light" as const);
  // #2208: through the SAME resolver `/booking/{id}` uses, because both routes
  // grade the same identity and a second copy of this rule would let one of them
  // go on asking a recognised lead to retype what Slate holds (L613).
  const attendee = await landingAttendee(
    { salesforceId: externalId },
    { name: first(sp, "name"), email: first(sp, "email"), phone },
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
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        landingCall={landingCall}
      />
    </StandaloneBookerShell>
  );
}
