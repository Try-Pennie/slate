import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { readLadderInputsLive } from "@/lib/availability/ladder-inputs-live";
import type { DroppedAdvisor } from "@/lib/availability/ladder-inputs";

/**
 * The call the check reads its windows around (#3530). The roster rows the read checks
 * whole do not depend on it; busy time, holds and counts are read an hour either side of
 * it (`LADDER_WINDOW_SLACK_MIN`), so its length and buffers move the window by minutes.
 */
const PROBE_CALL = { duration_min: 30, buffer_before_min: 0, buffer_after_min: 0 };

/**
 * The advisors the confirm's own ladder read leaves out right now: the same request and
 * the same reader a confirm uses (`readLadderInputsLive`), through every real bucket
 * code, so every org's roster is read. THROWS on any failure, and when there is no real
 * bucket to read through, because finding nothing to read is not a pass (L98).
 */
export async function readLadderDroppedLive(nowMs: number): Promise<readonly DroppedAdvisor[]> {
  const rows = unwrap(await supabaseAdmin().from("buckets").select("code").eq("is_test", false), "ladder dropped advisors buckets") as { code: string }[] | null;
  const codes = (rows ?? []).map((r) => r.code);
  if (codes.length === 0) throw new Error("no real bucket to read the ladder through, so nobody was judged");
  const ladder = await readLadderInputsLive(codes, new Date(nowMs).toISOString(), PROBE_CALL);
  return ladder.dropped;
}
