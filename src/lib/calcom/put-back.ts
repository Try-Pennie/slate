import { parseStampMs } from "@/lib/date/stamp";
import { selectAllPages } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { isRetiredSkip } from "@/lib/monitor/calcom-override-sweep";
import type { PutBackCounts } from "@/lib/calcom/put-back-copy";
import { log } from "@/lib/log";

/**
 * Putting cal.com back after it was marked retired (#2890).
 *
 * While cal.com is retired, every approved absence records "skipped: cal.com
 * retired" instead of writing an override (#2875). Putting cal.com back must copy
 * those into it, or every agent who booked time off during retirement is bookable
 * in cal.com right through it.
 *
 * The COPY is done by the override sweep on the monitor lane, which retries a
 * retired skip once cal.com is live (`isRetiredSkip`). Nothing is queued here: the
 * recorded skip IS the queue, so pressing "Put cal.com back" twice cannot copy
 * anything twice, and the sweep writes the new outcome back as each one lands, which
 * is what takes it out of the count.
 *
 * The other direction is a block cal.com still holds for time off cancelled or
 * changed while it was retired. The cancellation records that window in
 * `calcom_override_removals` (migration 0153), and the same sweep takes it out once
 * cal.com is live, so the admin is told that count too (`loadStaleBlockCount`).
 *
 * What lives here is the COUNT the admin is shown, before pressing and after, and
 * it has to be the sweep's own selection rather than a second definition of it
 * (L16): approved (the loader's filter), not ended, an agent who is still here, and
 * the retired skip, judged by the sweep's own predicate.
 */

/** One approved request, as the count reads it. */
export interface PutBackRow {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  effect: string;
}

/**
 * How many approved requests the sweep will copy into cal.com once it is live.
 *
 * An unreadable end is COUNTED: the sweep's loader judges "not ended" in SQL and
 * hands such a row over, so dropping it here would make the count lower than what
 * actually gets copied.
 */
export function putBackBacklog(rows: PutBackRow[], activeUserIds: Set<string>, nowMs: number): number {
  return rows.filter((r) => {
    if (!isRetiredSkip(r.effect)) return false;
    if (!activeUserIds.has(r.userId)) return false;
    const endMs = parseStampMs(r.endsAt);
    return endMs === null || endMs > nowMs;
  }).length;
}

/** The narrow client this needs, so the loader can be handed a fake. */
type Db = ReturnType<typeof import("@/lib/supabase/admin").supabaseAdmin>;

/**
 * Read the count, or `null` when it could not be read. Never 0 for a failure: a
 * zero tells the admin there is nothing to copy, which is the one claim a failed
 * read cannot make (L622).
 */
export async function loadPutBackBacklog(db: Db, nowMs: number): Promise<number | null> {
  try {
    const rows = await selectAllPages<{
      id: string;
      user_id: string;
      starts_at: string;
      ends_at: string;
      side_effects: Record<string, string> | null;
    }>("calcom.putBackBacklog", "id", () =>
      db
        .from("ooo_requests")
        .select("id, user_id, starts_at, ends_at, side_effects")
        .eq("status", "approved")
        .gt("ends_at", new Date(nowMs).toISOString()),
    );
    const waiting: PutBackRow[] = rows
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        // The same key the sweep and every writer use (EFFECTS.calcom).
        effect: r.side_effects?.calcom ?? "",
      }))
      .filter((r) => isRetiredSkip(r.effect));
    if (waiting.length === 0) return 0;

    // Active agents only, as the sweep's loader does: an override for somebody who
    // has left protects nothing, and the sweep never copies it. Chunked by URL
    // budget, since PostgREST refuses an in() filter past a few hundred ids.
    const ids = [...new Set(waiting.map((r) => r.userId))];
    const pages = await inIdChunks("calcom.putBackBacklog users", ids, async (chunk) => {
      const { data, error } = await db
        .from("users")
        .select("id")
        .in("id", chunk)
        .is("deactivated_at", null);
      if (error) throw new Error(`calcom.putBackBacklog users read failed: ${error.message}`);
      return (data ?? []) as { id: string }[];
    });
    const active = new Set(pages.flat().map((u) => u.id));
    return putBackBacklog(waiting, active, nowMs);
  } catch (err) {
    log.error("calcom-put-back", { msg: "backlog unreadable" }, err instanceof Error ? err : undefined);
    return null;
  }
}

/**
 * How many blocks cal.com still holds for time off cancelled or changed while it
 * was retired: unresolved rows of `calcom_override_removals` whose window has not
 * ended, which is exactly what the sweep's removal loader hands over. Null when the
 * read failed, never 0.
 */
export async function loadStaleBlockCount(db: Db, nowMs: number): Promise<number | null> {
  try {
    const rows = await selectAllPages<{ id: string }>("calcom.staleBlockCount", "id", () =>
      db
        .from("calcom_override_removals")
        .select("id")
        .is("resolved_at", null)
        .gt("ends_at", new Date(nowMs).toISOString()),
    );
    return rows.length;
  } catch (err) {
    log.error("calcom-put-back", { msg: "stale block count unreadable" }, err instanceof Error ? err : undefined);
    return null;
  }
}

/** Both reads, side by side; one failing does not hide the other. */
export async function loadPutBackCounts(db: Db, nowMs: number): Promise<PutBackCounts> {
  const [copy, remove] = await Promise.all([loadPutBackBacklog(db, nowMs), loadStaleBlockCount(db, nowMs)]);
  return { copy, remove };
}

// The words live in a module with no server imports, so the "use client" switch
// can render them; re-exported here for the server side callers.
export {
  PUT_BACK_UNKNOWN,
  putBackConfirmSentence,
  putBackQuery,
  putBackSavedSentence,
  type PutBackCounts,
} from "@/lib/calcom/put-back-copy";
