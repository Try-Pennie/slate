import ManageBooking from "@/components/ManageBooking";
import ManageNotFound from "@/components/ManageNotFound";
import StandaloneTheme from "@/components/StandaloneTheme";
import { getBookingByToken } from "@/lib/booking/service";
import { loadReasonOptions } from "@/lib/booking/reason-options";

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
  const reasonOptions = await loadReasonOptions();

  // #706: paint the theme at the document root so dark renders don't leave a
  // beige gutter behind the content card. Always standalone (never embedded).
  if (!found) {
    return (
      <>
        <StandaloneTheme theme={theme} />
        <ManageNotFound theme={theme} />
      </>
    );
  }

  return (
    <>
      <StandaloneTheme theme={theme} />
      <ManageBooking
        token={token}
        bucketCode={found.bucket.code}
        startsAt={found.booking.starts_at}
        status={found.booking.status}
        eventName={found.eventType.name}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        theme={theme}
      />
    </>
  );
}
