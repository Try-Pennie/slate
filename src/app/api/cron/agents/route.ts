import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { AGENTS_SYNC_STREAK_KEY } from "@/lib/salesforce/sync";
import { runRosterSync } from "@/lib/salesforce/run-roster-sync";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { recordFailureStreak } from "@/lib/notify/streak";
import { log } from "@/lib/log";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { agentSyncFailureAlert } from "@/lib/monitor/cron-alert-copy";

export const dynamic = "force-dynamic";

const SYNC_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Streak so a single failing pass stays quiet (transient SF blips self-heal next
// hour) and only CONSECUTIVE failures alert (#486). The window comfortably spans
// two hourly passes so the second genuinely-consecutive failure lands in it. The
// key is shared with the admin manual-sync action (#491) via salesforce/sync.
const AGENTS_STREAK_WINDOW_S = 3 * 60 * 60;

/**
 * Hourly roster maintenance: pull agent/team changes from Salesforce (existing
 * agents get attribute updates via the merge; new agents arrive bookable=false
 * and become bookable on their first tier, #2071; departed synced-only agents are
 * deactivated) and give any schedule-less agent the org default working hours so
 * they are never silently unavailable once flipped bookable.
 *
 * Since #2097 the job also reads Twilio TaskRouter, so an agent carrying the
 * `Redistribute` tag is taken out of the bookable pool and one who no longer carries
 * it is put back. A Twilio failure is contained: it never destroys the Salesforce
 * half's report, and it is never silent either (its own alert, its own line).
 *
 * The job itself is `runRosterSync`, shared with the admin "Sync from Salesforce and
 * Twilio" button so a hand run does the whole hour's work under the same lock. What
 * is only this route's is the bearer check and the failure streak.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/agents");
  if (claimed) return claimed;

  try {
    const outcome = await runRosterSync();
    if (outcome.skipped) return NextResponse.json({ skipped: outcome.skipped });
    return NextResponse.json({
      ...outcome.sync,
      // #2097: the Twilio half, as the discriminated pair the runner produced. A
      // response that flattened it to counts could not tell a read that failed from
      // one that found nobody tagged, and those are opposite facts.
      twilio: outcome.twilio,
      hoursApplied: outcome.hoursApplied,
      // #3177: why this run stopped part way (its lock taken, or its renewal refused), or null.
      leaseStop: outcome.leaseStop,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("agents", { msg: "cron failed", error: message });
    // This lane speaks for its own failure, so its alerting runs inside laneFailure
    // and the dispatcher's generic page stands down (one failure, one message).
    return laneFailure("agents", message, async () => {
      // Only alert on CONSECUTIVE failures (#486): a single transient blip (e.g. a
      // Cloudflare 522 to Salesforce) self-heals on the next hourly run.
      const consecutive = await recordFailureStreak(AGENTS_SYNC_STREAK_KEY, AGENTS_STREAK_WINDOW_S);
      if (consecutive) {
        // alert-key: agent_sync_failures
        await sendThrottledAlert(
          "agent_sync_failures",
          SYNC_ALERT_COOLDOWN_MS,
          agentSyncFailureAlert(message.slice(0, 300)),
        ).catch(logAlertSendFailure("agent_sync_failures"));
      }
    });
  }
}
