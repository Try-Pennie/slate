import { NextResponse } from "next/server";
import { requireManager } from "@/lib/auth";
import { listActiveAgents } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

/** Active agents for the manager reassign picker (#546). Manager+ gated; minimal
 *  fields only. The client filters/sorts via rankReassignAgents. */
export async function GET() {
  const me = await requireManager();
  return NextResponse.json({ agents: await listActiveAgents(me.org_id) });
}
