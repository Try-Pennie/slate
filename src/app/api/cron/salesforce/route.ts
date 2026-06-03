import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { syncSalesforceAgents } from "@/lib/salesforce/sync";

export const dynamic = "force-dynamic";

/** Periodic Salesforce agent sync (attributes + roster). */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const result = await syncSalesforceAgents();
  return NextResponse.json(result);
}
