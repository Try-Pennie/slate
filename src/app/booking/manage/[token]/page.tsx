import ManageBooking from "@/components/ManageBooking";
import ManageNotFound from "@/components/ManageNotFound";
import { getBookingByToken } from "@/lib/booking/service";

export const dynamic = "force-dynamic";
// Lead-facing: the brand is Pennie; Slate stays internal.
export const metadata = { title: "Manage your booking with Pennie" };

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
    return <ManageNotFound theme={theme} />;
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
