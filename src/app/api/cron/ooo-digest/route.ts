import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { dmSlackUserByEmail } from "@/lib/notify/slack";
import {
  buildManagerDigests,
  isDigestTime,
  type DigestManager,
  type DigestPendingRequest,
} from "@/lib/ooo/digest";
import { formatWhenLine } from "@/lib/ooo/core";
import type { OooRequest } from "@/lib/db/types";
import { log } from "@/lib/log";

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
    // cap-safe: the org's pending time off queue, drained by moderation.
    .from("ooo_requests")
    .select("id, user_id, manager_id, starts_at, ends_at, display_tz_id, display_tz_label, reason")
    .eq("status", "pending")
    .not("manager_id", "is", null);
  const pendingReqs = (pendingRows ?? []) as Pick<
    OooRequest,
    | "id"
    | "user_id"
    | "manager_id"
    | "starts_at"
    | "ends_at"
    | "display_tz_id"
    | "display_tz_label"
    | "reason"
  >[];
  if (pendingReqs.length === 0) {
    return NextResponse.json({ sent: 0, pending: 0 });
  }

  // One users read covers both the managers (recipients) and the agents (named in
  // each request's line). Bounded by the roster (an id set), never a growth table.
  const userIds = [
    ...new Set(
      pendingReqs.flatMap((r) => [r.manager_id, r.user_id]).filter((id): id is string => !!id),
    ),
  ];
  const { data: userRows } = await db
    .from("users")
    .select("id, email, name")
    .in("id", userIds);
  const usersById = new Map<string, DigestManager>(
    ((userRows ?? []) as DigestManager[]).map((u) => [u.id, u]),
  );

  // Route builds each request's descriptive line (agent + when + reason); the pure
  // digest builder turns them into per-request Approve/Decline rows (#194).
  const pending: DigestPendingRequest[] = pendingReqs.map((r) => {
    const agent = r.user_id ? usersById.get(r.user_id) : null;
    const who = agent?.name ?? agent?.email ?? "An agent";
    const when = formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label);
    return {
      id: r.id,
      manager_id: r.manager_id,
      line: `*${who}* wants time off\n${when}\nReason: ${r.reason}`,
    };
  });

  const digests = buildManagerDigests(pending, usersById, `${appUrl()}/admin/ooo`);
  let sent = 0;
  let failed = 0;
  for (const d of digests) {
    // Interactive blocks carry the buttons; d.text is the notification fallback.
    // Per-manager isolation: one manager's Slack failure must not abort the rest
    // of the digest run (fail-loud, not fail-silent: the error is logged and the
    // failed count surfaced, rather than 500ing the whole cron tick).
    try {
      if (await dmSlackUserByEmail(d.email, d.text, d.blocks)) sent++;
      else failed++;
    } catch (err) {
      failed++;
      log.error("ooo-digest", { msg: "digest DM failed", manager: d.managerId }, err);
    }
  }
  return NextResponse.json({
    sent,
    failed,
    managers: digests.length,
    pending: pending.length,
  });
}
