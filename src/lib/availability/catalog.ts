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
export function deriveAttributeCatalog(
  attributesList: (Attributes | null | undefined)[],
): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {};
  for (const attrs of attributesList) {
    if (!attrs) continue;
    for (const [key, val] of Object.entries(attrs)) {
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
