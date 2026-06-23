import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureDefaultOrg } from "@/lib/provision";
import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import { ensureDefaultSchedules } from "@/lib/schedule";
import { alertOnEmptyBuckets } from "@/lib/availability/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { sendThrottledAlert } from "@/lib/notify/dispatch";

export const dynamic = "force-dynamic";

const AGENTS_LOCK_TTL_MS = 10 * 60 * 1000;
const SYNC_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Daily roster maintenance: pull agent/team changes from Salesforce (existing
 * agents get attribute updates via the merge; new agents arrive
 * bookable=false; departed synced-only agents are removed) and give any
 * schedule-less agent the org default working hours so they are never
 * silently unavailable once flipped bookable.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const lock = await acquireLock("cron_agents", AGENTS_LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const sync = await syncSalesforceAgents();
    const org = await ensureDefaultOrg();
    const hoursApplied = await ensureDefaultSchedules(org.id);
    // After the roster settles, flag any bucket that now routes to nobody (#327).
    // Best-effort: a monitoring miss must never fail the roster reconcile.
    const coverage = await alertOnEmptyBuckets().catch(() => ({ empty: [] }));
    return NextResponse.json({ ...sync, hoursApplied, emptyBuckets: coverage.empty });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`agents cron failed: ${message}`);
    await sendThrottledAlert(
      "agent_sync_failures",
      SYNC_ALERT_COOLDOWN_MS,
      `Slate: the daily Salesforce agent sync failed (${message.slice(0, 300)}). Agent teams and the roster may be stale until it succeeds or someone runs Sync from the admin page.`,
    ).catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_agents", lock);
  }
}
