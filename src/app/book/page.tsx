import Booker from "@/components/Booker";
import StandaloneTheme from "@/components/StandaloneTheme";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: "Book a call with Pennie" };

type SP = Record<string, string | string[] | undefined>;

/** Canonical --pennie-sky; the embed explicitly passes it as the default
 *  brandColor (D14). A host can still override via the `brand` param. */
const PENNIE_SKY = "#82D0FF";

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

  const bucketCode = first(sp, "xbc");
  if (!bucketCode) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-8">
        <p className="max-w-md text-sm text-fg-muted">
          This booking link is missing its configuration (no <code>xbc</code>).
        </p>
      </main>
    );
  }

  const { data: bucketRow } = await supabaseAdmin()
    .from("buckets")
    .select("org_id, is_test")
    .eq("code", bucketCode)
    .maybeSingle();
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

  return (
    <main>
      {/* #706: standalone renders paint the theme at the document root so a dark
          booker has no beige gutter. The embed leaves the host in control. */}
      {!embedded && <StandaloneTheme theme={theme} />}
      {/* #1368: a bundle that throws before the customer can submit produces no
          request at all, so every server side detector stays green while nobody
          can book. This is the only signal for that. It mounts inside Slate's own
          document, which covers the standalone page and the embed iframe alike. */}
      <ClientErrorBeacon page="/book" bucketCode={bucketCode} />
      <Booker
        bucketCode={bucketCode}
        salesforceId={first(sp, "external_id") || null}
        attendee={{
          name: first(sp, "name"),
          email: first(sp, "email"),
          phone,
        }}
        prefill={prefill}
        embedded={embedded}
        theme={theme}
        brandColor={first(sp, "brand") || (embedded ? PENNIE_SKY : undefined)}
        parentOrigin={first(sp, "parentOrigin") || undefined}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
      />
    </main>
  );
}
