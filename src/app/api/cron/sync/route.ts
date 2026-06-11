import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureWatches, runIncrementalSync } from "@/lib/google/sync";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { formatWatchLapseAlert } from "@/lib/notify/alerts";

export const dynamic = "force-dynamic";

const WATCH_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert within 30 min

/** Post a throttled Slack alert when watch renewals are failing. */
async function alertWatchLapse(watchErrors: number, totalAgents: number): Promise<void> {
  if (watchErrors === 0) return;
  await sendThrottledAlert(
    "watch_lapse",
    WATCH_ALERT_COOLDOWN_MS,
    formatWatchLapseAlert(watchErrors, totalAgents),
  );
}

/**
 * Backstop sync (~1 min). Catches any push notification Google may have missed
 * and renews watch channels nearing expiry.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // A slow pass (full resync) can outlive the 1-minute cadence; overlapping
  // invocations would re-sync every calendar in parallel for nothing (#30).
  const lock = await acquireLock("cron_sync", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    // Sync calendars for bookable agents (calendar access is via delegation).
    const { data } = await supabaseAdmin()
      .from("users")
      .select("id")
      .eq("bookable", true);

    const userIds = (data ?? []).map((r) => (r as { id: string }).id);
    const results: {
      userId: string;
      watch: string;
      watchError?: string;
      synced?: number;
      error?: string;
    }[] = [];
    for (const userId of userIds) {
      const watch = await ensureWatches(userId);
      const row: (typeof results)[number] = {
        userId,
        watch: watch.status,
        ...(watch.status === "error" ? { watchError: watch.error } : {}),
      };
      try {
        row.synced = await runIncrementalSync(userId);
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      results.push(row);
    }

    const watchErrors = results.filter((r) => r.watch === "error").length;
    await alertWatchLapse(watchErrors, userIds.length);

    return NextResponse.json({ agents: userIds.length, watchErrors, results });
  } finally {
    await releaseLock("cron_sync", lock);
  }
}
