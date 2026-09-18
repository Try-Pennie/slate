/**
 * The string comparators every sort in Slate breaks a tie with (#2561).
 *
 * `a < b ? -1 : a > b ? 1 : 0` was written out at five sort sites and reversed
 * by hand at two of them. Sharing it is not only about the repetition: a hand
 * reversal reads identically to a hand ascending sort, so the only symptom of
 * getting one backwards is a list in the wrong order on a screen nobody diffs.
 * With both directions here, `compareStringsDesc` is the inverse of
 * `compareStrings` by construction, and `scripts/test-compare.ts` pins that.
 *
 * Deliberately `<`/`>` rather than `localeCompare`: every caller sorts machine
 * values (bucket codes, uuids, fixed offset ISO timestamps) where a locale aware
 * ordering would be wrong, would depend on the ambient locale of whichever
 * isolate served the request, and would put a stored ISO stamp's ordering at the
 * mercy of a collation table.
 */

/** Ascending lexicographic order: `a` before `b`. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Descending lexicographic order: `b` before `a`. Written by handing the
 * ascending comparator its arguments the other way round, rather than as a
 * second chain with the arms swapped, so the two can never disagree about a
 * pair. (Not `-compareStrings(a, b)`, which answers a tie with negative zero.)
 */
export function compareStringsDesc(a: string, b: string): number {
  return compareStrings(b, a);
}
