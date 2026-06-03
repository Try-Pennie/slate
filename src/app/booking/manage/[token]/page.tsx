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
      <main className="p-8 text-sm text-neutral-500">
        We couldn&apos;t find that booking.
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
