/**
 * Bucket availability counted in calls (#3939, Dan, 2026-10-20): a pool's day is the calls taken by
 * anything on its advisors' calendars out of the calls their shifts could hold, added up from the
 * same per advisor numbers Team capacity shows, through Team capacity's own `dayTotals`, so the two
 * pages agree and one word means one measure (L118). Not syncing and out advisors count in neither.
 *
 * Pure: the page's loader reads the advisors and each pool's eligible advisors (staffing depth's
 * own list), and hands this the result. The monitor's nearly full check never calls it.
 */
import { dayTotals, type TeamCapacityAdvisor } from "./team-capacity.ts";

/** A pool's day in calls. */
export interface PoolCalls {
  taken: number;
  capacity: number;
}

/** Each code's calls per office day, from its eligible advisors' days. */
export function callsByCode(
  agentsByCode: Map<string, string[]>,
  advisors: TeamCapacityAdvisor[],
  days: string[],
): Map<string, Map<string, PoolCalls>> {
  const byId = new Map(advisors.map((a) => [a.id, a]));
  const out = new Map<string, Map<string, PoolCalls>>();
  for (const [code, ids] of agentsByCode) {
    // Each advisor once, and only those the capacity read holds (bookable and not a test advisor).
    const members = [...new Set(ids)].map((id) => byId.get(id)).filter((a): a is TeamCapacityAdvisor => a !== undefined);
    const perDay = new Map<string, PoolCalls>();
    days.forEach((iso, i) => {
      const t = dayTotals(members, i);
      perDay.set(iso, { taken: t.capacity - t.open, capacity: t.capacity });
    });
    out.set(code, perDay);
  }
  return out;
}
