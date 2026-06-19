import Booker from "@/components/Booker";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeBookerLayout } from "@/lib/booking/layout";

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
    .select("org_id")
    .eq("code", bucketCode)
    .maybeSingle();
  const orgId = bucketRow?.org_id ?? null;
  const { data: orgRow } = orgId
    ? await supabaseAdmin()
        .from("organizations")
        .select("booker_layout")
        .eq("id", orgId)
        .maybeSingle()
    : { data: null };
  const layout = normalizeBookerLayout(orgRow?.booker_layout);

  const phone =
    first(sp, "phone") ||
    first(sp, "attendeePhoneNumber") ||
    first(sp, "smsReminderNumber");

  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    prefill[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }

  const embedded = first(sp, "embed") === "1";

  return (
    <main>
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
        theme={first(sp, "theme") === "dark" ? "dark" : "light"}
        brandColor={first(sp, "brand") || (embedded ? PENNIE_SKY : undefined)}
        layout={layout}
      />
    </main>
  );
}
