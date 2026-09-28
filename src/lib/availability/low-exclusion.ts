import type { Attributes } from "../db/types.ts";
import { DEBT_TIER } from "../xbc.ts";

/**
 * Who carries the Low debt tier, and the pool without them (#2842).
 *
 * A top tier lead (Ultra High or Very High) who is cascaded below their own tier
 * must never be offered an advisor who also carries Low. Sales ops, 2026-09-28
 * (Slack #C091G6LEQ80, p1790609176877419), Sam: "as long as the person who is on
 * Medium isn't also on Low". WHICH rungs that applies to is decided in one place,
 * `rungExcludesLow` in `src/lib/routing/tiers.ts`; this module only answers who
 * carries Low and what a pool looks like without them.
 *
 * Pure and relative imports only, so the node suite drives it directly.
 */

/** The debt_team key the Twilio sync writes for the Low tier, from the one table. */
const LOW_KEY = DEBT_TIER["1"]!.key;

/** Whether an advisor's attributes put them on the Low team. Array or scalar, like
 *  every other routing attribute (`matchesCriteria`). */
export function carriesLow(attributes: Attributes | null | undefined): boolean {
  const have = attributes?.debt_team;
  if (have === undefined || have === null) return false;
  return (Array.isArray(have) ? have : [have]).some((v) => String(v) === LOW_KEY);
}

/** The ids, among `agents`, that carry Low. */
export function lowCarrierIds(agents: { id: string; attributes: Attributes | null }[]): string[] {
  return agents.filter((a) => carriesLow(a.attributes)).map((a) => a.id);
}

/**
 * `ids` with every Low carrier removed, in the order given.
 *
 * FAILS CLOSED: when `lowIds` is unknown (undefined), nobody is returned. Reading
 * an unknown list as "nobody carries Low" would hand a top tier lead to exactly
 * the advisors the rule exists to keep away. Offering nobody on a rung is
 * recoverable, because the cascade then walks on or opens the rung above it.
 */
export function withoutLowCarriers(ids: string[], lowIds: string[] | undefined): string[] {
  if (lowIds === undefined) return [];
  const low = new Set(lowIds);
  return ids.filter((id) => !low.has(id));
}
