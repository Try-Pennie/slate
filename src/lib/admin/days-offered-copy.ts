/**
 * The words on the Hours page's "Days offered" card (#3922).
 *
 * Two numbers live on that card and they are different facts. `OFFERED_OPEN_DAYS`
 * (fixed in code, 3) is how many open days every lead is offered. `horizon_days`
 * (the box, 4 in production) is how far the last resort (#2841) may reach when
 * every tier the lead may use is full for those days. The card used to say
 * "offered" of both, so Dan read the box as the normal window and asked why it said
 * 4 when the paragraph said 3.
 *
 * So the box has ONE name, and it is held here: the label, the save button, the
 * saved sentence and the refusals all read it from this constant, which is how the
 * button stops being a third name ("Save booking horizon") for the same thing.
 *
 * Pure (no `@/` imports), so the node suite and client code can both reach it.
 */

/** The box's name, wherever it is referred to. */
export const LAST_RESORT_REACH = "Last resort reach";

/** The save button, naming the same thing the label does. */
export const SAVE_LAST_RESORT_REACH = `Save ${LAST_RESORT_REACH.toLowerCase()}`;

/** The term beside the fixed fact. */
export const EVERY_LEAD_TERM = "Every lead";

/** The fixed number, stated as a value rather than inside a sentence. */
export function offeredDaysValue(offeredOpenDays: number): string {
  return `Next ${offeredOpenDays} open days`;
}

/** The one qualification the value needs, from the cutoff constant's own label. */
export function todayCountsNote(cutoffLabel: string): string {
  return `Today counts only before ${cutoffLabel}.`;
}

/**
 * What the last resort IS, said once, on the box (announced with it through
 * `aria-describedby`). The domain only: when it applies, how its days are counted,
 * and the value at which there is none. The fixed number appears only in that last
 * clause, because the value above the box already states it.
 */
export function lastResortReachHint(offeredOpenDays: number): string {
  return (
    `If every tier a lead may use is full for their offered days, the booker ` +
    `shows later days as a last resort, up to this many days with times counted from ` +
    `today, so a closed day does not use one up. At ${offeredOpenDays} or fewer there is ` +
    `no last resort.`
  );
}
