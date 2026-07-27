import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pruneCutoffIso } from "@/lib/routing/retention";
import { exportedThrough, mirrorReadyForDeletion } from "@/lib/snowflake/retention-gate";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_routing", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const cutoff = pruneCutoffIso(new Date().toISOString());
    // Export-gated (#1102): never delete a routing_decision the Snowflake mirror
    // does not yet hold. Gate the whole run on a passing reconciliation, and only
    // delete rows at or before the confirmed-export watermark. Deleting a row does
    // not propagate to Snowflake (the warehouse keeps its full history).
    const gate = await mirrorReadyForDeletion();
    if (!gate.ready) {
      log.info("prune-routing", { msg: "skipped: mirror not ready", reason: gate.reason });
      return NextResponse.json({ skipped: "mirror-not-ready", reason: gate.reason });
    }
    const exportedTo = await exportedThrough("routing_decisions");
    if (!exportedTo) return NextResponse.json({ skipped: "nothing-exported-yet" });

    const { error, count } = await supabaseAdmin()
      .from("routing_decisions")
      .delete({ count: "exact" })
      .lt("created_at", cutoff)
      .lte("created_at", exportedTo);
    if (error) throw new Error(error.message);
    return NextResponse.json({ pruned: count ?? 0, cutoff, exportedThrough: exportedTo });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-routing", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_routing", lock);
  }
}
