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
import { agentDisplayName, formatRequestWhenAndReason } from "@/lib/ooo/core";
import type { OooRequest } from "@/lib/db/types";
import { log } from "@/lib/log";
import { digestUnreachableAlert, digestUnreachableRecovery } from "@/lib/monitor/cron-alert-copy";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";

export const dynamic = "force-dynamic";

// #1001: a manager's digest can silently fail to deliver (a broken Slack
// email-to-user mapping, or a Slack API error), and pending time off requests
// then pile up unseen. Fold each delivery result into the shared
// consecutive-failure streak so a lone transient blip stays quiet but a mapping
// that stays broken escalates to a throttled alert.
const FAIL_STREAK_WINDOW_SECONDS = 3 * 24 * 60 * 60; // > the ~24h digest cadence, so consecutive daily failures accumulate in one window
const ALERT_AFTER_RUNS = 2; // day one may be a transient Slack blip; the second consecutive miss alerts
const ALERT_COOLDOWN_MS = 22 * 60 * 60 * 1000; // remind about once a day while a mapping stays broken, no more

/**
 * Record one manager's digest delivery outcome. A clean send clears the streak;
 * a failure bumps it and, once it reaches ALERT_AFTER_RUNS consecutive misses,
 * fires a throttled Slack alert naming the unreachable manager. Best-effort: the
 * streak helpers swallow their own errors, and the alert is wrapped, so tracking
 * or alerting trouble can never abort the rest of the digest run.
 */
async function noteDigestDelivery(managerId: string, managerLabel: string, ok: boolean) {
  const streakKey = `ooo-digest-send-fail:${managerId}`;
  if (ok) {
    await clearFailureStreak(streakKey);
    // #1151: "this manager is not receiving their digest" is a CONDITION that
    // ends the moment one reaches them, and this delivery IS that observation.
    // Hung off the successful send, so it can never clear on a run where the
    // send failed. resolveAlert is a no-op unless a page was delivered.
    const cleared = await resolveAlert(
      `ooo-digest-unreachable:${managerId}`,
      digestUnreachableRecovery(managerLabel),
    ).catch((err) => {
      log.error("ooo-digest", { msg: "recovery notice failed", manager: managerId }, err);
      return false;
    });
    if (cleared) log.info("ooo-digest", { msg: "unreachable alert cleared", manager: managerId });
    return;
  }
  const tripped = await recordConsecutiveStreak(
    streakKey,
    FAIL_STREAK_WINDOW_SECONDS,
    ALERT_AFTER_RUNS,
  );
  if (!tripped) return;
  try {
    await sendThrottledAlert(
      `ooo-digest-unreachable:${managerId}`,
      ALERT_COOLDOWN_MS,
      digestUnreachableAlert(managerLabel, ALERT_AFTER_RUNS),
    );
  } catch (err) {
    log.error("ooo-digest", { msg: "delivery alert failed", manager: managerId }, err);
  }
}

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
    // Agent label + when/reason body come from the shared builders (#1002) so this
    // line can never drift from the per-request manager notification.
    return {
      id: r.id,
      manager_id: r.manager_id,
      line: `*${agentDisplayName(agent)}* wants time off\n${formatRequestWhenAndReason(r)}`,
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
    const label = usersById.get(d.managerId)?.name ?? d.email;
    let ok = false;
    try {
      ok = !!(await dmSlackUserByEmail(d.email, d.text, d.blocks));
    } catch (err) {
      log.error("ooo-digest", { msg: "digest DM failed", manager: d.managerId }, err);
    }
    if (ok) sent++;
    else failed++;
    // Escalate a mapping that stays broken across runs, instead of swallowing it.
    await noteDigestDelivery(d.managerId, label, ok);
  }
  return NextResponse.json({
    sent,
    failed,
    managers: digests.length,
    pending: pending.length,
  });
}
