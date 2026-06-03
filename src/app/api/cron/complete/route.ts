import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { completePastBookings } from "@/lib/booking/service";
import { retryFailedDeliveries } from "@/lib/webhooks/emit";

export const dynamic = "force-dynamic";

/** Marks finished bookings complete and retries failed webhook deliveries. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const completed = await completePastBookings();
  const retried = await retryFailedDeliveries();
  return NextResponse.json({ completed, retried });
}
