/**
 * What the working hours week says back after an action (#2106).
 *
 * PURE, so `scripts/test-working-hours-copy.ts` drives every shape without a DOM.
 * The strings live here rather than inline in the component for the reason every
 * other copy module in this tree exists: a sentence assembled from a count reads
 * wrongly at exactly one count, and that is the one nobody types into a fixture.
 */

/**
 * What "Copy Monday to every working day" did.
 *
 * The empty case is its own sentence rather than a zero, because the reader's
 * question is not how many days were copied but whether the control works: an agent
 * whose only ticked day is Monday presses something that can only ever do nothing,
 * and silence teaches them it is broken rather than that their week has no other
 * days in it (L109).
 */
export function copyMondayOutcome(workingDaysCopiedTo: number): string {
  if (workingDaysCopiedTo === 0) {
    return "No other days are ticked, so there was nothing to copy Monday to.";
  }
  return workingDaysCopiedTo === 1
    ? "Copied Monday to your one other working day."
    : `Copied Monday to your other ${workingDaysCopiedTo} working days.`;
}
