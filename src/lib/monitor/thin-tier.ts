import type { TierDepth } from "@/lib/routing/staffing-depth";

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
 * The tiers worth a staffing nudge: single points of failure (depth 1) and thin
 * tiers (depth 2). Depth-0 tiers are deliberately excluded: a true dead-end is
 * already the #371 availability probe's / #567 fallback notice's job, and folding
 * it in here would double-notify. `ok` (3+) tiers are healthy.
 */
export function selectThinTiers(depths: TierDepth[]): TierDepth[] {
  return depths.filter((t) => t.flag === "spof" || t.flag === "thin");
}

/** Human line for one thin tier, thinnest-first ordering preserved by the caller. */
function tierLine(t: TierDepth): string {
  const head = `${t.code} (${t.name})`;
  const body =
    t.flag === "spof"
      ? t.soleAgentName
        ? `only ${t.soleAgentName} can take these bookings (single point of failure)`
        : "rests on a single agent (single point of failure)"
      : "only 2 agents deep, one time-off or offboarding from a single point of failure";
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
  const lines = tiers.slice(0, NAME_CAP).map(tierLine);
  const more = tiers.length > NAME_CAP ? ` (and ${tiers.length - NAME_CAP} more)` : "";
  return (
    `Slate (info): ${tiers.length} tier(s) are thinly staffed (1 to 2 bookable agents), ` +
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
