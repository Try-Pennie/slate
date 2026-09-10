import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * True if an agent's attributes satisfy every key in `criteria` (AND across
 * keys). For each key, the agent matches if any of its values for that key
 * intersects any of the criterion's wanted values — so both the attribute and
 * the criterion may be scalars or arrays (e.g. an agent on multiple debt teams).
 * Empty criteria matches nobody (buckets then rely on manual members).
 *
 * A key ending in "!" negates: the agent must NOT have any of the wanted
 * values for that attribute, and an UNSET attribute passes — cal.com's
 * "Legal Eligible does not equal N" semantics, where only explicitly-marked
 * agents are excluded (e.g. criteria `{ "backend_service!": "achieve" }`).
 */
export function matchesCriteria(
  attributes: Attributes | null | undefined,
  criteria: Criteria | null | undefined,
): boolean {
  const keys = criteria ? Object.keys(criteria) : [];
  if (keys.length === 0) return false;
  const attrs = attributes ?? {};

  return keys.every((key) => {
    const negated = key.endsWith("!");
    const want = criteria![key];
    const have = attrs[negated ? key.slice(0, -1) : key];
    const wantSet = (Array.isArray(want) ? want : [want]).map(String);

    if (negated) {
      if (have === undefined || have === null) return true;
      const haveSet = (Array.isArray(have) ? have : [have]).map(String);
      return !haveSet.some((h) => wantSet.includes(h));
    }

    if (have === undefined || have === null) return false;
    const haveSet = (Array.isArray(have) ? have : [have]).map(String);
    return haveSet.some((h) => wantSet.includes(h));
  });
}
