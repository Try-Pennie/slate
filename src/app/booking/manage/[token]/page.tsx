import ManageBooking from "@/components/ManageBooking";
import { getBookingByToken } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

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

  if (!found) {
    return (
      <main
        data-theme={theme}
        className="flex min-h-dvh items-center justify-center bg-bg p-8"
      >
        <p className="text-sm text-fg-muted">
          We couldn&apos;t find that booking.
        </p>
      </main>
    );
  }

  return (
    <ManageBooking
      token={token}
      bucketCode={found.bucket.code}
      startsAt={found.booking.starts_at}
      status={found.booking.status}
      eventName={found.eventType.name}
      theme={theme}
    />
  );
}
