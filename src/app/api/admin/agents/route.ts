import { NextResponse } from "next/server";
import { requireManager } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { listActiveAgents } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

/** Active agents for the manager reassign picker (#546). Manager+ gated; minimal
 *  fields only. The client filters/sorts via rankReassignAgents. */
export async function GET() {
  let me: Awaited<ReturnType<typeof requireManager>>;
  try {
    me = await requireManager();
  } catch (err) {
    return forbiddenResponse(err);
  }
  return NextResponse.json({ agents: await listActiveAgents(me.org_id) });
}
