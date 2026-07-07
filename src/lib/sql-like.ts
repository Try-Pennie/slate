/**
 * Escape a string so it matches ONLY itself when used as a Postgres LIKE/ILIKE
 * pattern (#620). LIKE treats `_` (any one char) and `%` (any run) as wildcards,
 * and `\` as the escape char. A user value passed verbatim to `.ilike(...)`
 * (e.g. `john_doe@example.com`) would therefore also match `johnXdoe@...`. Wrap
 * the value with this so the pattern is a literal, while still matching
 * case-insensitively (the trigram index serves an escaped literal fine).
 *
 * Escape `\` FIRST so we don't re-escape the backslashes we add for `_`/`%`.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[_%]/g, "\\$&");
}
