import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * True if an agent's attributes satisfy every key in `criteria` (AND across
 * keys). For each key, the agent matches if any of its values for that key
 * intersects any of the criterion's wanted values — so both the attribute and
 * the criterion may be scalars or arrays (e.g. an agent on multiple debt teams).
 * Empty criteria matches nobody (buckets then rely on manual members).
 */
export function matchesCriteria(
  attributes: Attributes | null | undefined,
  criteria: Criteria | null | undefined,
): boolean {
  const keys = criteria ? Object.keys(criteria) : [];
  if (keys.length === 0) return false;
  const attrs = attributes ?? {};

  return keys.every((key) => {
    const want = criteria![key];
    const have = attrs[key];
    if (have === undefined || have === null) return false;
    const wantSet = (Array.isArray(want) ? want : [want]).map(String);
    const haveSet = (Array.isArray(have) ? have : [have]).map(String);
    return haveSet.some((h) => wantSet.includes(h));
  });
}
