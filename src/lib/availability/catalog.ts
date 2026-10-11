import type { Attributes } from "@/lib/db/types";

/**
 * Pure: build the routing-attribute catalog from the agents themselves — the
 * set of attribute keys and, per key, the values that actually exist across the
 * org's agents. The admin routing editor renders dropdowns from this, so a
 * bucket can only be routed on keys/values some agent really has. That removes
 * the typo-driven "matches zero agents" trap and needs no hand-maintained
 * catalog (it tracks the Salesforce sync automatically). Keys and values are
 * sorted for a stable UI.
 */
/**
 * Keys the roster sync writes onto `attributes` as its own lifecycle bookkeeping, which are not
 * routing facts and so are never offered as bucket criteria (#3615): the Redistribute and
 * demotion marks' timestamps, their swept markers, the missing worker stamp, and the tiers held
 * before a demotion (which read exactly like real tiers). `scripts/test-catalog.ts` derives the
 * keys from the real mark helpers, so a new one missing here fails the build.
 */
const SYNC_BOOKKEEPING_KEYS = new Set([
  "redistribute_at",
  "redistribute_swept_at",
  "twilio_worker_missing_since",
  "demotion_marked_at",
  "demotion_swept_at",
  "demotion_from_debt_team",
  "demotion_from_backend_service",
]);

export function deriveAttributeCatalog(
  attributesList: (Attributes | null | undefined)[],
): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {};
  for (const attrs of attributesList) {
    if (!attrs) continue;
    for (const [key, val] of Object.entries(attrs)) {
      if (SYNC_BOOKKEEPING_KEYS.has(key)) continue;
      const values = Array.isArray(val) ? val : [val];
      for (const v of values) {
        if (v === undefined || v === null || v === "") continue;
        (acc[key] ??= new Set<string>()).add(String(v));
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(acc).sort()) {
    out[key] = [...acc[key]].sort();
  }
  return out;
}
