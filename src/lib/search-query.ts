/**
 * How a typed search query is read, everywhere in Slate (#1791).
 *
 * Dan, 2026-09-03: "spaces should be counted in text matching. this should show
 * me nothing. \"John \" should show me john kite and sullivan but not anybody
 * with the last name johnson". A trailing space is how a person says "this is
 * the whole word", and it is the only way to say it, so the three search boxes
 * that were each trimming it away were each discarding the useful half.
 *
 * Two decisions live here, and both were previously re-made per call site.
 *
 * THE TRIM IS ASYMMETRIC, deliberately. A LEADING space is almost always noise
 * from a paste or a fat finger, so it goes. A TRAILING space is the word
 * boundary, so it stays. That resolves a real tension rather than ignoring it:
 * the roster's URL round trip was trimming both ends so that "  Ada " and "ada"
 * could not be two different filters with one address bar, and half of that
 * argument still holds. A query that is ONLY whitespace is no search at all,
 * because "nothing typed yet" and "found nobody" are different screens (L10).
 *
 * FIELDS ARE MATCHED SEPARATELY, never against a joined string. Joining a name
 * and an email with a space inserts a character that exists in no record, and
 * while spaces were being stripped nobody could see it. The moment a space
 * counts, that invented space is matchable: "kite jkite" matched John Kite by
 * spanning the gap between his name and his address, a string that appears
 * nowhere in the data. So the matcher takes the fields, not a haystack, and no
 * call site can reintroduce the join.
 *
 * Pure and dependency free, so it is node testable and both runtimes share it.
 */

/**
 * A raw search box value as the matcher should see it: lowercased, leading
 * whitespace removed, trailing whitespace KEPT, and reduced to the empty string
 * when nothing but whitespace was typed.
 */
export function normalizeSearchQuery(raw: string): string {
  const q = raw.replace(/^\s+/, "").toLowerCase();
  // Whitespace only means no search. Checked after the leading strip so a query
  // of spaces alone cannot survive as a search for a space.
  return q.trim() === "" ? "" : q;
}

/**
 * Whether any one of `fields` contains `needle`, which must already have been
 * through `normalizeSearchQuery`.
 *
 * An empty needle matches EVERYTHING, because that is the "nothing typed" state.
 * Each field is tested on its own, so a query can never match across the join
 * between two of them.
 */
export function matchesSearchQuery(
  needle: string,
  ...fields: (string | null | undefined)[]
): boolean {
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}
