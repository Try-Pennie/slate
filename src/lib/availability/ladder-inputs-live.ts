import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { ladderInputsFrom, ladderWindows, type LadderInputs } from "@/lib/availability/ladder-inputs";
import type { EventType } from "@/lib/db/types";

/**
 * The whole ladder's candidate inputs in one request (#3489, migration 0176), read
 * strictly: a failed or unreadable answer throws, never reads as an empty ladder.
 *
 * One binding for both readers (#3381): the confirm's walk (`realDeps`) and the monitor
 * lane's served versus confirm check, which judges a served time with the confirm's own
 * candidate read and so must read exactly what the confirm reads.
 */
export async function readLadderInputsLive(
  codes: readonly string[],
  startIso: string,
  eventType: Pick<EventType, "duration_min" | "buffer_before_min" | "buffer_after_min">,
): Promise<LadderInputs> {
  const windows = ladderWindows(startIso, eventType, Date.now());
  const data = unwrap(
    await supabaseAdmin().rpc("ladder_candidate_inputs", {
      p_codes: [...codes],
      p_busy_from: windows.busyFrom,
      p_busy_to: windows.busyTo,
      p_cap_from: windows.capFrom,
      p_cap_to: windows.capTo,
      p_share_from: windows.shareFrom,
      p_share_to: windows.shareTo,
      p_exceptions_from: windows.exceptionsFrom,
    }),
    "ladder candidate inputs",
  );
  return ladderInputsFrom(data, windows);
}
