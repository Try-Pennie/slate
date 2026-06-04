import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureWatch, runIncrementalSync } from "@/lib/google/sync";

export const dynamic = "force-dynamic";

/**
 * Backstop sync (~1 min). Catches any push notification Google may have missed
 * and renews watch channels nearing expiry.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

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
    const watch = await ensureWatch(userId);
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
  return NextResponse.json({ agents: userIds.length, watchErrors, results });
}
