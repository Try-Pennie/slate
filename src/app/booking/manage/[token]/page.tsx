import ManageBooking from "@/components/ManageBooking";
import { getBookingByToken } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

export default async function ManagePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const found = await getBookingByToken(token);

  if (!found) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-8">
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
    />
  );
}
