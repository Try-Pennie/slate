/**
 * The one definition of what the deactivate confirm ASKS, and what its answer
 * looks like on the wire (#2124).
 *
 * Dan, 2026-09-09: "can we add a warning asking if they'd like to sweep? that way
 * it's a deliberate choice." So deactivating an agent who still holds upcoming
 * bookings offers two ways forward, and the answer travels as the pressed
 * button's own name and value.
 *
 * It lives HERE, in lib, rather than in the component that writes it, because the
 * server action reads it and a server module importing a client one to borrow a
 * string is the shape that gets untangled later by copying the string. Two copies
 * of a wire value drift silently and in the worst direction: a mismatch makes
 * every press fall through to the default, so customers would be stranded while
 * the admin believed they had chosen to move them (L263).
 *
 * `readCoverageChoice` is the only reader, so the DEFAULT is decided once. It is
 * "leave", and that is the safe half of the asymmetry: a missing or misspelled
 * value must never be able to start moving customers' appointments, because
 * nobody asked and nothing on screen would say it happened. The opposite mistake,
 * a move the admin chose that did not run, is loud, since the agent is left
 * deactivated holding bookings and `inactive_agent_bookings` pages within the
 * hour.
 */
export const COVERAGE_CHOICE_FIELD = "coverage";
export const COVERAGE_CHOICE_MOVE = "move";
export const COVERAGE_CHOICE_LEAVE = "leave";

/** Whether the admin chose to move the departed agent's upcoming bookings. */
export function readCoverageChoice(value: FormDataEntryValue | null): boolean {
  return value === COVERAGE_CHOICE_MOVE;
}
