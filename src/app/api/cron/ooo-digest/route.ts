import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { dmSlackUserByEmail } from "@/lib/notify/slack";
import {
  buildManagerDigests,
  isDigestTime,
  type DigestManager,
} from "@/lib/ooo/digest";

export const dynamic = "force-dynamic";

/**
 * Daily 9am ET nudge (port of the Pipedream flow): DM each manager the count
 * of OOO requests still waiting on them. Wired to two UTC crons (13:00 + 14:00
 * Mon-Fri) so it lands at 9am ET across DST; isDigestTime lets exactly one
 * through. `?force=1` bypasses the time gate for manual testing.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force && !isDigestTime(Date.now())) {
    return NextResponse.json({ skipped: "not 9am ET" });
  }

  const db = supabaseAdmin();
  const { data: pendingRows } = await db
    .from("ooo_requests")
    .select("manager_id")
    .eq("status", "pending")
    .not("manager_id", "is", null);
  const pending = (pendingRows ?? []) as { manager_id: string | null }[];
  if (pending.length === 0) {
    return NextResponse.json({ sent: 0, pending: 0 });
  }

  const managerIds = [
    ...new Set(pending.map((p) => p.manager_id).filter((id): id is string => !!id)),
  ];
  const { data: mgrRows } = await db
    .from("users")
    .select("id, email, name")
    .in("id", managerIds);
  const managers = new Map<string, DigestManager>(
    ((mgrRows ?? []) as DigestManager[]).map((m) => [m.id, m]),
  );

  const digests = buildManagerDigests(pending, managers, `${appUrl()}/admin/ooo`);
  let sent = 0;
  for (const d of digests) {
    if (await dmSlackUserByEmail(d.email, d.text)) sent++;
  }
  return NextResponse.json({
    sent,
    managers: digests.length,
    pending: pending.length,
  });
}
