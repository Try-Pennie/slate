import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { appUrl } from "@/lib/env";
import { dmSlackUserByEmail, postSlack } from "@/lib/notify/slack";
import {
  buildOooDigests,
  isDigestTime,
  type DigestPerson,
  type DigestPendingRequest,
} from "@/lib/ooo/digest";
import { agentDisplayName, formatRequestWhenAndReason } from "@/lib/ooo/core";
import type { OooRequest } from "@/lib/db/types";
import { log } from "@/lib/log";
import {
  digestUnreachableAlert,
  digestUnreachableRecovery,
  digestUnroutedUnreachableAlert,
  digestUnroutedUnreachableRecovery,
} from "@/lib/monitor/cron-alert-copy";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { OOO_DIGEST_ATTEMPT_LANE, OOO_DIGEST_NUDGE_LANE } from "@/lib/ooo/time-off-lanes";

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
 * Record whether the unrouted-requests post landed (#1499).
 *
 * Deliberately NOT folded into `noteDigestDelivery`: that one is keyed per
 * manager and its copy names a Slack address problem, which is the wrong
 * diagnosis here. One condition, one key, one set of words (L11).
 */
async function noteUnroutedDelivery(count: number, ok: boolean) {
  const streakKey = "ooo-digest-unrouted-fail";
  // alert-key: ooo-digest-unrouted-unreachable
  const alertKey = "ooo-digest-unrouted-unreachable";
  try {
    if (ok) {
      await clearFailureStreak(streakKey);
      // Hung off the MEASURED success, never off "we did not alert this run": a
      // run that threw or skipped measured nothing and must clear nothing.
      const cleared = await resolveAlert(alertKey, digestUnroutedUnreachableRecovery());
      if (cleared) log.info("ooo-digest", { msg: "unrouted alert cleared" });
      return;
    }
    const tripped = await recordConsecutiveStreak(
      streakKey,
      FAIL_STREAK_WINDOW_SECONDS,
      ALERT_AFTER_RUNS,
    );
    if (!tripped) return;
    await sendThrottledAlert(
      alertKey,
      ALERT_COOLDOWN_MS,
      digestUnroutedUnreachableAlert(count, ALERT_AFTER_RUNS),
    );
  } catch (err) {
    log.error("ooo-digest", { msg: "unrouted delivery tracking failed", count }, err);
  }
}

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
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/ooo-digest");
  if (claimed) return claimed;
  // #2543: the cron reached the route. Stamped BEFORE the time gate, so it is
  // written by both weekday triggers and says one thing only, that the dispatcher
  // is firing. Whether anybody was nudged is the second stamp, further down.
  await recordHeartbeat(OOO_DIGEST_ATTEMPT_LANE);

  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force && !isDigestTime(Date.now())) {
    return NextResponse.json({ skipped: "not 9am ET" });
  }

  const db = supabaseAdmin();
  // #2383: unwrap, never a swallowed `data`. An empty result is read twenty lines
  // down as the specific answer "nobody is waiting on a manager this morning",
  // and the lane answers `{ sent: 0, pending: 0 }` on a 200 with nobody nudged.
  // A throw is a 500 the cron records, which is the only thing that tells a
  // morning with an unreadable queue from a morning with an empty one.
  const pendingRows = unwrap(
    await db
      // cap-safe: the org's pending time off queue, drained by moderation.
      .from("ooo_requests")
      .select(
        "id, user_id, manager_id, starts_at, ends_at, display_tz_id, display_tz_label, reason",
      )
      .eq("status", "pending"),
    "ooo digest pending queue",
  );
  // #1499: no `manager_id is not null` filter. A request with no manager of
  // record is exactly the one nobody is nudged about, so filtering it out here
  // made the daily reminder quietest about the requests most likely to be
  // forgotten. It goes to the fallback channel post instead.
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
    // #2543: a MEASURED outcome, so the nudge stamp moves. "Nobody is waiting on a
    // manager this morning" is an answer, and the read above throws rather than
    // arriving here empty (#2383), so this branch can no longer be a failed read
    // wearing a quiet morning's clothes.
    await recordHeartbeat(OOO_DIGEST_NUDGE_LANE);
    return NextResponse.json({ sent: 0, pending: 0 });
  }

  // One users read covers both the managers (recipients) and the agents (named in
  // each request's line). Bounded by the roster (an id set), never a growth table.
  const userIds = [
    ...new Set(
      pendingReqs.flatMap((r) => [r.manager_id, r.user_id]).filter((id): id is string => !!id),
    ),
  ];
  // #2383: unwrap too, and this one decides where every request GOES. `role` is
  // what makes a request routed rather than unrouted, so a swallowed error empties
  // the map, every manager looks unable to approve, and the whole queue is posted
  // to the fallback channel with nobody named on any line. That reads exactly like
  // a morning where nobody had an approver.
  const userRows = unwrap(
    await db
      .from("users")
      // `role` decides whether a manager of record may actually approve (#1475),
      // which is what makes a request routed rather than unrouted.
      .select("id, email, name, role")
      .in("id", userIds),
    "ooo digest people",
  );
  const usersById = new Map<string, DigestPerson>(
    ((userRows ?? []) as DigestPerson[]).map((u) => [u.id, u]),
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

  const { managers: digests, unrouted } = buildOooDigests(
    pending,
    usersById,
    `${appUrl()}/admin/ooo`,
  );

  // Requests nobody can be nudged about go to the shared fallback channel, which
  // is where the per-request notification already sends them on the day they are
  // submitted. Wrapped, because a Slack failure here must not abort the manager
  // DMs below, and logged rather than swallowed so a channel that stops accepting
  // posts is visible in the logs alongside the returned count.
  let unroutedPosted = false;
  if (unrouted) {
    try {
      const r = await postSlack({ text: unrouted.text, blocks: unrouted.blocks });
      unroutedPosted = r.ok;
      if (!r.ok) {
        log.warn("ooo-digest", {
          msg: "unrouted digest post failed",
          count: unrouted.count,
          reason: r.error ?? "unknown",
        });
      }
    } catch (err) {
      log.error("ooo-digest", { msg: "unrouted digest post threw", count: unrouted.count }, err);
    }
    // L13: a background job that only LOGS its failure is invisible twice. These
    // are the requests with no assigned approver, so a post that keeps failing
    // leaves the least watched part of the queue with nobody watching it. Same
    // streak machinery as a manager's DM, one fixed key, and best-effort so a
    // tracking problem can never abort the run it is observing (L71).
    await noteUnroutedDelivery(unrouted.count, unroutedPosted);
  }

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

  // #2543: the run reached the end of the queue, so the morning's nudging really
  // happened. A per manager Slack failure does NOT withhold this: that condition
  // has its own streak and its own page a few lines up, and suppressing the stamp
  // for it would report the SCHEDULE as stopped when it is running perfectly and
  // one address is wrong (L11). What withholds the stamp is a throw before here,
  // which is the unreadable queue this lane used to answer 200 to.
  await recordHeartbeat(OOO_DIGEST_NUDGE_LANE);

  return NextResponse.json({
    sent,
    failed,
    managers: digests.length,
    // Reported separately from `sent`, because a run that nudged every manager
    // while failing to post the unrouted requests is not a clean run.
    unrouted: unrouted?.count ?? 0,
    unroutedPosted,
    pending: pending.length,
  });
}
