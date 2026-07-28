import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pruneCutoffIso } from "@/lib/routing/retention";
import { exportedThrough, mirrorReadyForDeletion } from "@/lib/snowflake/retention-gate";
import { MAX_VERIFY_BATCH, destroyVerified } from "@/lib/snowflake/verify-archived";
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

    // Read a BOUNDED batch of candidates and prove the warehouse holds each one
    // before deleting it (#1102). The watermark predicate below is only a cheap
    // pre-filter: a 12-month-old row is always below a watermark that is minutes
    // old, so it can never actually withhold a candidate. The read-back is the
    // real gate. Strict `<` (was `.lte`): the export cursor is a composite
    // (created_at, id) keyset, so a row whose created_at equals the watermark but
    // whose id sorts later was not necessarily exported.
    const db = supabaseAdmin();
    const { data: aged, error: readErr } = await db
      .from("routing_decisions")
      .select("id,created_at")
      .lt("created_at", cutoff)
      .lt("created_at", exportedTo)
      .order("created_at", { ascending: true })
      .limit(MAX_VERIFY_BATCH);
    if (readErr) throw new Error(readErr.message);
    const candidates = ((aged ?? []) as { id: string; created_at: string }[]).map((r) => ({
      id: r.id,
      watermark: r.created_at,
    }));

    const report = await destroyVerified({
      table: "routing_decisions",
      watermarkCol: "created_at",
      candidates,
      destroy: async (ids) => {
        const { error, count } = await db
          .from("routing_decisions")
          .delete({ count: "exact" })
          .in("id", ids);
        if (error) throw new Error(error.message);
        return count ?? 0;
      },
    });
    if (report.problems.length > 0) {
      log.warn("prune-routing", {
        msg: "left unverified rows in place",
        unverified: report.problems.length,
        first: report.problems[0].id,
        state: report.problems[0].state,
      });
    }
    return NextResponse.json({ pruned: report.destroyed, candidates: report.candidates, cutoff });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-routing", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_routing", lock);
  }
}
