import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { listPoolBuckets } from "@/lib/availability/precompute";
import { groupByPool } from "@/lib/availability/pool-key";
import { roundRobinCandidates } from "@/lib/availability/service";
import { readLadderInputsLive } from "@/lib/availability/ladder-inputs-live";
import {
  MAX_JUDGMENTS_PER_TICK,
  OFFERED_NOBODY_FREE_SEEN_PREFIX,
  suspectId,
  type JudgeEventType,
  type Judgment,
  type Suspect,
} from "@/lib/monitor/offered-nobody-free";

/**
 * The database half of the served versus confirm check (#3381). Every read here
 * THROWS on failure: an empty pool list or an empty marker set would each read as
 * "nothing to judge" and let the check clear a condition still true.
 */

/** The real (not test) bucket codes, grouped by pool and sorted within each. */
export async function loadRealPools(): Promise<string[][]> {
  const groups = groupByPool(await listPoolBuckets());
  return [...groups.values()]
    .map((members) => members.filter((m) => !m.bucket.is_test).map((m) => m.code).sort())
    .filter((codes) => codes.length > 0);
}

const markerKey = (code: string, startMs: number) => `${OFFERED_NOBODY_FREE_SEEN_PREFIX}:${suspectId(code, startMs)}`;

/** Read back as many as can exist, plus room: the set is bounded by the judgment budget
 *  (see the prefix's own comment), so a full read means something else wrote here. */
const MARKER_READ_LIMIT = MAX_JUDGMENTS_PER_TICK * 4;

/** The times remembered by earlier ticks. */
export async function readOfferedSuspects(): Promise<Suspect[]> {
  const rows = (unwrap(
    await supabaseAdmin()
      .from("alert_state")
      .select("key, last_sent_at")
      .like("key", `${OFFERED_NOBODY_FREE_SEEN_PREFIX}:%`)
      .limit(MARKER_READ_LIMIT),
    "offered nobody free markers",
  ) ?? []) as { key: string; last_sent_at: string }[];
  if (rows.length >= MARKER_READ_LIMIT) {
    // A partial set would let the all clear fire past a marker it never saw.
    throw new Error(`read ${rows.length} offered nobody free markers, at the read limit, so the set may be partial`);
  }
  const out: Suspect[] = [];
  for (const r of rows) {
    // `like` treats the underscores in the prefix as wildcards, so the exact prefix is
    // checked here rather than trusted.
    if (!r.key.startsWith(`${OFFERED_NOBODY_FREE_SEEN_PREFIX}:`)) continue;
    const rest = r.key.slice(OFFERED_NOBODY_FREE_SEEN_PREFIX.length + 1);
    const at = rest.lastIndexOf("@");
    const startMs = at > 0 ? parseStampMs(rest.slice(at + 1)) : null;
    const firstSeenMs = parseStampMs(r.last_sent_at);
    if (startMs === null || firstSeenMs === null) {
      throw new Error(`an offered nobody free marker cannot be read: ${r.key}`);
    }
    out.push({ code: rest.slice(0, at), startMs, firstSeenMs });
  }
  return out;
}

export async function markOfferedSuspect(code: string, startMs: number, firstSeenMs: number): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("alert_state")
    .upsert({ key: markerKey(code, startMs), last_sent_at: new Date(firstSeenMs).toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`offered nobody free marker write failed for ${code}: ${error.message}`);
}

export async function clearOfferedSuspect(code: string, startMs: number): Promise<void> {
  const { error } = await supabaseAdmin().from("alert_state").delete().eq("key", markerKey(code, startMs));
  if (error) throw new Error(`offered nobody free marker clear failed for ${code}: ${error.message}`);
}

/**
 * The confirm's own candidate read for one served time: the ladder read the confirm
 * makes, judged by `roundRobinCandidates` exactly as a confirm on that code would be
 * (preview, so it never pages about ordering). Null when the code has no bucket.
 */
export async function judgeOfferedTime(code: string, startMs: number, eventType: JudgeEventType): Promise<Judgment | null> {
  const ladder = await readLadderInputsLive([code], new Date(startMs).toISOString(), eventType);
  const resolved = ladder.bucket(code);
  if (!resolved) return null;
  const { candidates, memberCount } = await roundRobinCandidates(
    resolved.bucket,
    resolved.eventType,
    startMs,
    true,
    undefined,
    false,
    { inputs: ladder },
  );
  return { free: candidates.length, members: memberCount };
}
