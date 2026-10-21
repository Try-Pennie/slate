import { planOffboardingCoverageSweep, type OffboardingSweepPlan } from "../offboarding/coverage-trigger.ts";
import { log } from "../log.ts";

/** One advisor the reap's write departed, with the stamp the row now carries. */
export interface ReapDeparture {
  id: string;
  deactivatedAtIso: string;
}

/** What the coverage of a run's departures came to, one count per advisor. */
export interface ReapCoverageCounts {
  queued: number;
  none: number;
  failed: number;
}

/**
 * Move the remaining calls of every advisor the hourly Salesforce reap just departed
 * (#1678), through the SAME offboarding coverage the lifecycle API runs (#1241): the
 * plan is `planOffboardingCoverageSweep`, keyed on the row's own stored departure stamp
 * (never a fresh clock read), so a retry of the same departure converges onto the one
 * sweep the unique (agent, departure) index allows, and `cover` is the shared
 * `coverDeparture`.
 *
 * Only advisors THIS run's write departed are passed in (the write is a compare and swap
 * on `deactivated_at is null`), so an admin's own departure in the admin UI, which keeps
 * its confirm step, is never swept from here.
 *
 * A failure never undoes or fails the departure, which is what stops the advisor being
 * offered for anything new. It is counted (the run's result carries it), logged at error
 * level, and backstopped by the `inactive_agent_bookings` monitor, which pages about a
 * departed advisor still holding future calls: the same handling the lifecycle API gives
 * the same failure. One advisor's failure never stops the next one being covered.
 */
export async function coverReapDepartures(
  departed: readonly ReapDeparture[],
  cover: (plan: OffboardingSweepPlan) => Promise<"queued" | "none" | "failed">,
): Promise<ReapCoverageCounts> {
  const counts: ReapCoverageCounts = { queued: 0, none: 0, failed: 0 };
  for (const d of departed) {
    const plan = planOffboardingCoverageSweep({ action: "deactivate", userId: d.id, deactivatedAtIso: d.deactivatedAtIso });
    if (!plan) continue;
    try {
      counts[await cover(plan)]++;
    } catch (err) {
      log.error("sf-sync", { msg: "coverage of a departed advisor's calls failed", user_id: d.id }, err);
      counts.failed++;
    }
  }
  return counts;
}
