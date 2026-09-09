import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { resolveRequestedCode } from "@/lib/routing/catchall";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: "Book a call with Pennie" };

type SP = Record<string, string | string[] | undefined>;

/** Canonical --pennie-sky; mirrors /book (D14): the embed gets it as the
 *  default brandColor, overridable via the `brand` param. */
const PENNIE_SKY = "#82D0FF";

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
  const requestedCode = first(sp, "xbc");
  const resolved = resolveRequestedCode(requestedCode);
  const bucketCode = resolved.code;

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
  const horizonDays = await loadBookingHorizonDays();
  // #1337: a lead who already has a call is offered the Move, which records a
  // mandatory reschedule reason chosen right there.
  const reasonOptions = await loadReasonOptions();

  return (
    <StandaloneBookerShell embedded={embedded} theme={theme}>
      <Booker
        bucketCode={bucketCode}
        requestedCode={requestedCode}
        salesforceId={id}
        attendee={{
          name: first(sp, "name"),
          email: first(sp, "email"),
          phone,
        }}
        prefill={prefill}
        embedded={embedded}
        theme={theme}
        brandColor={first(sp, "brand") || (embedded ? PENNIE_SKY : undefined)}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
      />
    </StandaloneBookerShell>
  );
}
