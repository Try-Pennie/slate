import { parseStampMs } from "@/lib/date/stamp";
import { selectAllPages } from "@/lib/supabase/paginate";
import { isRetiredSkip, MAX_RETRIES_PER_TICK } from "@/lib/monitor/calcom-override-sweep";
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
    }>("calcom.putBackBacklog", (from, to) =>
      db
        .from("ooo_requests")
        .select("id, user_id, starts_at, ends_at, side_effects")
        .eq("status", "approved")
        .gt("ends_at", new Date(nowMs).toISOString())
        .order("id")
        .range(from, to),
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
    // has left protects nothing, and the sweep never copies it. Bounded by the
    // roster, since the ids are distinct agents.
    const ids = [...new Set(waiting.map((r) => r.userId))];
    const { data: users, error } = await db
      .from("users")
      .select("id")
      .in("id", ids)
      .is("deactivated_at", null);
    if (error) throw new Error(`calcom.putBackBacklog users read failed: ${error.message}`);
    const active = new Set(((users ?? []) as { id: string }[]).map((u) => u.id));
    return putBackBacklog(waiting, active, nowMs);
  } catch (err) {
    log.error("calcom-put-back", { msg: "backlog unreadable" }, err instanceof Error ? err : undefined);
    return null;
  }
}

function requests(n: number): string {
  return n === 1 ? "1 approved time off request" : `${n} approved time off requests`;
}

/** How the sweep paces the copy, said once so the two sentences cannot disagree. */
const PACE = `the retry that runs every 5 minutes copies them, ${MAX_RETRIES_PER_TICK} at a time`;

/** The sentence on the put back confirmation, before the press. */
export function putBackConfirmSentence(n: number | null): string {
  if (n === null) {
    return "Time off approved while it was retired is copied into cal.com by the retry that runs every 5 minutes. How much is waiting could not be counted just now.";
  }
  if (n === 0) return "No time off approved while it was retired is waiting to be copied into cal.com.";
  return `${requests(n)} made while it was retired ${n === 1 ? "has" : "have"} not ended and ${n === 1 ? "is" : "are"} copied into cal.com: ${PACE}.`;
}

/** The value a put back redirect carries when the count could not be read. */
export const PUT_BACK_UNKNOWN = "unknown";

/** The query fragment the put back redirect appends after `savedQuery`. */
export function putBackQuery(n: number | null): string {
  return `&copy=${n === null ? PUT_BACK_UNKNOWN : String(n)}`;
}

/**
 * The saved notice after putting cal.com back, built from the `copy` value the
 * redirect carried. A value that is not a count (an old or hand edited link) claims
 * no number at all rather than a guessed one.
 */
export function putBackSavedSentence(raw: string | undefined | null): string {
  const base = "Saved: cal.com is back. Its lanes run again from their next scheduled check.";
  if (raw === PUT_BACK_UNKNOWN) {
    return `${base} Could not count the time off approved while it was retired; the retry that runs every 5 minutes copies it into cal.com regardless.`;
  }
  if (!raw || !/^\d+$/.test(raw)) return base;
  const n = Number(raw);
  if (n === 0) return `${base} No time off approved while it was retired needed copying into it.`;
  return `${base} ${requests(n)} made while it was retired ${n === 1 ? "is" : "are"} waiting to be copied into it: ${PACE}.`;
}
