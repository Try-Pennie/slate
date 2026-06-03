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
  const results: { userId: string; synced?: number; error?: string }[] = [];
  for (const userId of userIds) {
    await ensureWatch(userId).catch(() => {});
    try {
      const n = await runIncrementalSync(userId);
      results.push({ userId, synced: n });
    } catch (err) {
      results.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ agents: userIds.length, results });
}
