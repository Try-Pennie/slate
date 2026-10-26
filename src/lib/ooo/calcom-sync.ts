import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { parseStampMs } from "@/lib/date/stamp";
import { addOooOverrides, removeOooOverrides } from "@/lib/calcom/client";
import type { AbsenceWindow } from "@/lib/calcom/overrides";
import { log } from "@/lib/log";
import { calcomOverrideWriteSkip, loadCalcomRetired } from "@/lib/calcom/retirement";

/**
 * The ONE place the cal.com override dual-write is started from (#2417).
 *
 * A date's overrides are derived from every approved absence touching it, so
 * every writer has to supply the same set: the approval, the cancellation, the
 * narrowing edit that runs a cancellation and a fresh approval, and the monitor
 * lane's retry sweep. Leaving each of them to read it separately is how two
 * definitions of "this agent's approved time off" drift, and the drift here is
 * silent in the worst direction, since a short read reopens the agent's day.
 *
 * The read REFUSES rather than degrading. An empty set is a measured answer (the
 * agent has no other approved absence); a failed read has measured nothing, and
 * writing an override computed from it would hand cal.com back the hours another
 * approved absence is holding (L214, L211).
 */

/**
 * How far either side of the absence to look for others.
 *
 * The dates being rewritten are local dates in the cal.com schedule's timezone,
 * which is not known until cal.com answers, and zone offsets run to fourteen
 * hours. One day of slack covers every zone, and over-reading costs nothing: the
 * pure computation clips each window to the dates it is actually rewriting.
 */
const ZONE_SLACK_MS = 24 * 60 * 60 * 1000;

export interface CalcomOverrideSyncArgs {
  /** "add" for an approval or a retry, "remove" for a cancellation or a narrowing. */
  mode: "add" | "remove";
  /** The request being written, excluded from the read so ordering cannot double-count it. */
  requestId: string;
  agentUserId: string;
  agentEmail: string;
  startIso: string;
  endIso: string;
}

/**
 * Every OTHER approved absence of this agent that could touch the same dates.
 *
 * `null` means the read FAILED and is not interchangeable with `[]`.
 */
export async function loadOtherApprovedWindows(args: {
  agentUserId: string;
  requestId: string;
  startIso: string;
  endIso: string;
}): Promise<AbsenceWindow[] | null> {
  const startMs = parseStampMs(args.startIso);
  const endMs = parseStampMs(args.endIso);
  if (startMs === null || endMs === null) {
    log.error("ooo-calcom", {
      msg: "unreadable window bounds",
      request_id: args.requestId,
    });
    return null;
  }
  const from = new Date(startMs - ZONE_SLACK_MS).toISOString();
  const to = new Date(endMs + ZONE_SLACK_MS).toISOString();
  try {
    const rows = await selectAllPages<{ starts_at: string; ends_at: string }>(
      "ooo.otherApprovedWindows",
      "id",
      () =>
        supabaseAdmin()
          .from("ooo_requests")
          .select("id, starts_at, ends_at")
          .eq("user_id", args.agentUserId)
          .eq("status", "approved")
          .neq("id", args.requestId)
          .lt("starts_at", to)
          .gt("ends_at", from),
    );
    return rows.map((r) => ({ startIso: r.starts_at, endIso: r.ends_at }));
  } catch (err) {
    log.error(
      "ooo-calcom",
      { msg: "other approved windows unreadable", request_id: args.requestId },
      err,
    );
    return null;
  }
}

/** Approve, cancel or retry one absence's cal.com overrides. */
export async function syncCalcomOverrides(
  args: CalcomOverrideSyncArgs,
): Promise<string> {
  // #2875: once cal.com is marked retired nothing books through it, so there is
  // nothing an override could protect. Checked HERE because every writer starts
  // here, the monitor lane's retry included, which never consulted the deploy
  // level OOO_CALCOM_DUAL_WRITE flag. Read fresh, never cached, and a failed read
  // WRITES as today: during the parallel run a missing block lets cal.com book
  // somebody who is away, while a write to a retired cal.com is one failed call.
  const retiredSkip = calcomOverrideWriteSkip(await loadCalcomRetired());
  if (retiredSkip) return retiredSkip;
  const others = await loadOtherApprovedWindows({
    agentUserId: args.agentUserId,
    requestId: args.requestId,
    startIso: args.startIso,
    endIso: args.endIso,
  });
  if (others === null) {
    // Not retryable-by-wording here: the caller records this outcome and the
    // monitor lane's sweep is what tries again, on its own cadence.
    return "failed: this agent's other approved time off could not be read, so no override was written";
  }
  return args.mode === "add"
    ? addOooOverrides(args.agentEmail, args.startIso, args.endIso, others)
    : removeOooOverrides(args.agentEmail, args.startIso, args.endIso, others);
}
