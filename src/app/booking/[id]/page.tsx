import Booker from "@/components/Booker";

export const dynamic = "force-dynamic";

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

  const bucketCode = first(sp, "xbc");
  if (!bucketCode) {
    return (
      <main className="p-8 text-sm text-neutral-500">
        This booking link is missing its configuration (no <code>xbc</code>).
      </main>
    );
  }

  const phone =
    first(sp, "phone") ||
    first(sp, "attendeePhoneNumber") ||
    first(sp, "smsReminderNumber");

  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    prefill[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }

  return (
    <Booker
      bucketCode={bucketCode}
      salesforceId={id}
      attendee={{
        name: first(sp, "name"),
        email: first(sp, "email"),
        phone,
      }}
      prefill={prefill}
      embedded={first(sp, "embed") === "1"}
    />
  );
}
