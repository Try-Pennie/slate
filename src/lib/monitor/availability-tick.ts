/**
 * The two decisions the monitor tick makes around the availability scan when the
 * org's hours may be unreadable (#1296). Pure, no `@/` imports, so
 * `scripts/test-monitor-availability-tick.ts` drives them directly: they used to
 * live inline in the route, where the dangerous branch had nothing asserting it.
 *
 * Both exist to keep ONE distinction: a tick that could not measure is not a tick
 * that measured nothing wrong.
 */
import { slotHealthByCode, type SlotHealthRow, type SlotHealth } from "./slot-health.ts";
import type { BusinessHoursRules } from "../availability/compute.ts";

/**
 * The per-bucket slot counts for this tick, or `null` meaning DO NOT SCAN.
 *
 * The counts are filtered to the org's hours so they match what the booker serves.
 * When the hours could not be read there is no honest count to produce, and the
 * tempting shortcut, an empty map, is the worst possible answer: every bucket would
 * come back with zero slots and the scan would page the entire ladder. Returning
 * null forces the caller to skip instead.
 */
export function slotHealthForTick(
  rows: SlotHealthRow[],
  businessHours: BusinessHoursRules | null,
): Map<string, SlotHealth> | null {
  if (businessHours === null) return null;
  return slotHealthByCode(rows, businessHours);
}

/** What the tick's response says about the availability scan. */
export interface AvailabilityScanReport {
  availabilityScan: "ran" | "skipped: business hours unreadable";
  /** How many buckets are failing, or `null` when the scan did not run. */
  failing: number | null;
}

/**
 * `failing: 0` from a SKIPPED scan reads exactly like `failing: 0` from a clean
 * one, and that is how a lane that has quietly stopped checking goes unnoticed. A
 * skipped scan therefore reports `null` and names itself.
 */
export function availabilityScanReport(
  scan: { page: string[] } | null,
): AvailabilityScanReport {
  if (scan === null) {
    return { availabilityScan: "skipped: business hours unreadable", failing: null };
  }
  return { availabilityScan: "ran", failing: scan.page.length };
}
