import {
  debtTierDepths,
  type DebtTierDepth,
  type TierDepth,
} from "@/lib/routing/staffing-depth";
import type { ThrottledNotify } from "./alert-deps";

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

/**
 * The tiers worth a staffing nudge, judged on EFFECTIVE depth (#738): a tier with
 * 1 or 2 agents actually available today, whether that is structural (a small
 * roster) or because agents are out today (#744: an approved time-off request or
 * an all-day block on the agent's own calendar).
 *
 * Effective-0 tiers are excluded, and since #2505 the reason is sharper than it
 * was: a tier with nobody available is `empty_tier:<digit>`, which PAGES, and
 * whispering about it here as well would tell the same person the same thing
 * twice in two voices (L11). Effective 3+ is healthy at this unit; the scale is
 * re-derived in `debtTierFlag` rather than borrowed from the pool one.
 */
export function selectThinTiers(depths: DebtTierDepth[]): DebtTierDepth[] {
  return depths.filter((t) => t.effectiveFlag === "spof" || t.effectiveFlag === "thin");
}

/** Human line for one thin DEBT TIER, thinnest-first ordering preserved by the
 *  caller. It names the tier in words and never a bucket code: the tier is what a
 *  person staffs, and a code inside it is not a thing anybody adds an agent to. */
function tierLine(t: DebtTierDepth): string {
  const head = t.name;
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
  return `${head}: ${body}.`;
}

/**
 * The Slack info notice for the current thin debt tiers, or "" when there are
 * none (so the cron sends nothing rather than a spurious "0 tiers" post). Tiers
 * arrive thinnest-first from `debtTierDepths`.
 *
 * There is no cap and no grouping any more, and both fall out of counting debt
 * tiers: there are five of them, so the whole list always fits and nothing can be
 * hidden behind an "(and N more)" tail. It used to group fifteen pools (#2237)
 * because one thinly staffed tier arrived as six identical lines; that problem
 * cannot arise at this unit.
 */
export function formatThinTierNotice(tiers: DebtTierDepth[]): string {
  if (!tiers.length) return "";
  const what = tiers.length === 1 ? "1 debt tier is" : `${tiers.length} debt tiers are`;
  return (
    `${what} thinly staffed (1 to 2 agents available today), ` +
    `so add coverage before customers hit empty availability.\n` +
    tiers.map(tierLine).join("\n")
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
  notify: ThrottledNotify;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<number> {
  const thinTiers = selectThinTiers(debtTierDepths(await deps.loadDepths()));
  if (thinTiers.length) {
    await deps
      .notify(THIN_TIER_STAFFING_KEY, deps.cooldownMs, formatThinTierNotice(thinTiers))
      .catch(() => {});
  }
  deps.log?.(`monitor thin-tier: ${thinTiers.length} thin debt tier(s) (depth<=2)`);
  return thinTiers.length;
}
