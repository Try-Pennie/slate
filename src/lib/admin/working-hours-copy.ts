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

/**
 * The line an agent reads over their own week when somebody else put it there
 * (#1757).
 *
 * Only the cal.com import is named, because it is the one writer Slate can PROVE
 * set these hours for the agent without asking them: `hours_source` records it.
 * A week stamped before the stamp existed (null) says nothing, since claiming it
 * came from cal.com would be a guess dressed as a record (L192). The seeded default
 * already has its own alert and is not this sentence's business.
 */
export function hoursOriginNote(
  source: "seed" | "agent" | "admin" | "calcom-import" | null,
): string | null {
  if (source !== "calcom-import") return null;
  return "These hours were copied from your cal.com schedule when Slate was set up. Check they match the hours you actually work.";
}
