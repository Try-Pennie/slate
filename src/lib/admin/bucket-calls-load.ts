/**
 * The reads behind Bucket availability's calls (#3939): Team capacity's own reads (the call setting,
 * the bookable advisors, their calendars, time off and sync health), turned into each pool's calls
 * per day by `callsByCode`. Null when any of them fails, so the page draws every open day unknown
 * rather than a pool with no room (L10).
 */
import { log } from "@/lib/log";
import { teamCapacityReport } from "./team-capacity";
import { loadCapacityPeople, loadCapacityRules } from "./team-capacity-load";
import { callsByCode, type PoolCalls } from "./bucket-calls";

export async function loadPoolCalls(
  orgId: string,
  /** Each code's eligible advisors, as staffing depth lists them. */
  agentsByCode: Map<string, string[]>,
  /** The page's office days, yyyy-mm-dd. */
  days: string[],
  nowMs: number,
): Promise<Map<string, Map<string, PoolCalls>> | null> {
  const rules = await loadCapacityRules(orgId);
  if (!rules.ok) {
    log.error("bucket-supply", { msg: "calls unreadable", reason: rules.reason }, rules.err);
    return null;
  }
  const people = await loadCapacityPeople(orgId, rules.value, days);
  if (!people.ok) {
    // Nobody bookable is a state, not a failed read: every pool then holds no calls.
    if (people.reason === "no-advisors") return callsByCode(agentsByCode, [], days);
    log.error("bucket-supply", { msg: "calls unreadable", reason: people.reason }, people.err);
    return null;
  }
  try {
    const { advisors } = teamCapacityReport({ days, ...people.value, eventType: rules.value.eventType, hours: rules.value.hours, nowMs });
    return callsByCode(agentsByCode, advisors, days);
  } catch (err) {
    log.error("bucket-supply", { msg: "calls unreadable", reason: "calendars" }, err);
    return null;
  }
}
