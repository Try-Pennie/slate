import { sameTierReading, type TierDepth } from "@/lib/routing/staffing-depth";
import { groupRowsByPool } from "@/lib/admin/pool-rows";

// alert_state row key for the throttle; lives with the feature so the cron and
// the settings screen refer to the one constant.
export const THIN_TIER_STAFFING_KEY = "thin_tier_staffing";

/**
 * #569: the proactive thin-tier early warning. #584 shipped the pull surface
 * (`/admin/tiers`); this is the push surface, a low-priority Slack whisper on the
 * monitor cron so staffing can add coverage or set a fallback BEFORE a thin tier
 * saturates and trips the reactive #371/#567 availability signals.
 *
 * Pure and IO-free: the cron feeds in the already-computed depths and posts the
 * formatted notice through `sendThrottledInfo`.
 */

// Match the other monitor notices' list cap so a broad thin-staffing state stays
// one readable Slack post, not a wall of tiers.
const NAME_CAP = 8;

/**
 * The tiers worth a staffing nudge, judged on EFFECTIVE depth (#738): a tier with
 * 1 or 2 agents actually available today, whether that is structural (a small
 * roster) or because agents are out today (#744: an approved time-off request or
 * an all-day block on the agent's own calendar). Effective-0 tiers are
 * excluded: an all-out tier is a live dead-end already covered by the #371
 * availability probe / #567 fallback notice, so folding it in would double-notify.
 * Effective 3+ is healthy.
 */
export function selectThinTiers(depths: TierDepth[]): TierDepth[] {
  return depths.filter((t) => t.effectiveFlag === "spof" || t.effectiveFlag === "thin");
}

/** Human line for one thin POOL, thinnest-first ordering preserved by the caller. */
function tierLine(t: TierDepth, codes: string[], label: string | null): string {
  // #2237: the pool is what a person staffs, and the CODES are what the landing
  // pages send, so the line carries both. Before this it named one code per line
  // and printed six of them for one problem.
  const which = codes.length === 1 ? `bucket ${codes[0]}` : `buckets ${codes.join(", ")}`;
  const head = label ? `${label} (${which})` : `${which} (${t.name})`;
  const avail = t.effectiveDepth === 1 ? "1 agent" : "2 agents";
  let body: string;
  if (t.outCount > 0) {
    // A roster-deep tier thinned by who is out today: show both so staffing sees
    // it is temporary and how many are out.
    body = `${t.depth} on the roster but only ${avail} available today (${t.outCount} out today)`;
  } else if (t.flag === "spof" && t.soleAgentName) {
    // Structural single point of failure: name the sole agent.
    body = `only ${t.soleAgentName} can take these bookings (single point of failure)`;
  } else {
    body = `only ${avail} deep`;
  }
  // A working fallback means an empty tier still routes, so it's lower urgency,
  // but the tier is still structurally thin (depth is reported fallback-blind).
  const cushion = t.hasWorkingFallback
    ? " A fallback agent is set, so it's lower urgency, but the tier is still thin."
    : "";
  return `${head}: ${body}.${cushion}`;
}

/**
 * The Slack info notice for the current thin tiers, or "" when there are none
 * (so the cron sends nothing rather than a spurious "0 tiers" post). Tiers arrive
 * thinnest-first from `bucketStaffingDepths`; the list is capped like the sibling
 * notices with an "(and N more)" tail.
 */
export function formatThinTierNotice(tiers: TierDepth[]): string {
  if (!tiers.length) return "";
  // Grouped by POOL (#2237). Sixty bucket codes route through fifteen pools, so
  // one thinly staffed tier used to arrive as six identical lines. With the list
  // capped at eight names, a SINGLE thin pool filled it and hid every other
  // finding behind "(and N more)", while the headline counted six times the
  // number of problems a person could actually act on.
  const groups = groupRowsByPool(tiers, sameTierReading);
  const lines = groups
    .slice(0, NAME_CAP)
    .map((g) => tierLine(g.rows[0]!, g.codes, g.label));
  const more = groups.length > NAME_CAP ? ` (and ${groups.length - NAME_CAP} more)` : "";
  const what = groups.length === 1 ? "1 pool is" : `${groups.length} pools are`;
  return (
    `${what} thinly staffed (1 to 2 agents available today), ` +
    `so add coverage or set a fallback before customers hit empty availability.${more}\n` +
    lines.join("\n")
  );
}

/**
 * The monitor-cron step: load depths, pick the thin tiers, and (only if any)
 * whisper them through `notify` on the given cooldown. Dependency-injected so the
 * IO stays testable. Returns the thin-tier count for the cron's response/log.
 *
 * The notify failure is swallowed (fail-soft): a flaky Slack must never fail the
 * monitor tick or block its heartbeat/other lanes. The gate is the persistent
 * `alert_state` cooldown inside `notify`, not this call.
 */
export async function runThinTierStaffingCheck(deps: {
  loadDepths: () => Promise<TierDepth[]>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<number> {
  const thinTiers = selectThinTiers(await deps.loadDepths());
  if (thinTiers.length) {
    await deps
      .notify(THIN_TIER_STAFFING_KEY, deps.cooldownMs, formatThinTierNotice(thinTiers))
      .catch(() => {});
  }
  deps.log?.(`monitor thin-tier: ${thinTiers.length} thin tier(s) (depth<=2)`);
  return thinTiers.length;
}
