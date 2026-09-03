/**
 * The keyboard model of a listbox, as pure functions (#1849).
 *
 * Replacing a native `<select>` means taking on the keyboard contract the
 * browser was providing for nothing: arrows, Home and End, and type ahead. Doing
 * that badly trades a plain looking control for an inaccessible one, so the
 * rules live here where they can be stated and tested as rules rather than
 * inferred from a component's behaviour.
 */

/** How long a type ahead buffer survives a pause before it starts again. */
export const TYPE_AHEAD_RESET_MS = 800;

/**
 * Where the highlight goes for a navigation key, or null when the key means
 * nothing here or there is nothing to move to.
 *
 * WRAPS at both ends: the ends of a list are not dead, and a native select wraps
 * too, so not wrapping would be a regression a keyboard user feels immediately.
 */
export function nextIndex(
  current: number | null,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current === null ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current === null ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The option a type ahead buffer selects, or null for no match.
 *
 * The search starts AFTER the current row for a single character and AT it for
 * more, which is the behaviour a native select has and is not arbitrary: tapping
 * one letter repeatedly should cycle through the options sharing it, while
 * typing a longer word must be able to land on the row it is already on, or
 * every second keystroke jumps away from the thing being spelled.
 *
 * It wraps, so a match earlier in the list is still reachable from the end.
 */
export function typeAheadIndex(
  labels: string[],
  buffer: string,
  current: number | null,
): number | null {
  const needle = buffer.toLowerCase();
  if (needle.length === 0 || labels.length === 0) return null;
  const from = current === null ? 0 : needle.length === 1 ? current + 1 : current;
  for (let i = 0; i < labels.length; i++) {
    const at = (from + i + labels.length) % labels.length;
    if (labels[at]!.toLowerCase().startsWith(needle)) return at;
  }
  return null;
}
