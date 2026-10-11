import type { Attributes } from "@/lib/db/types";
import { REDISTRIBUTE_AT_KEY, REDISTRIBUTE_SWEPT_KEY, TWILIO_WORKER_MISSING_KEY } from "@/lib/twilio/roster-plan";
import {
  DEMOTION_FROM_BACKEND_KEY,
  DEMOTION_FROM_DEBT_KEY,
  DEMOTION_MARK_KEY,
  DEMOTION_SWEPT_KEY,
} from "@/lib/booking/demotion-plan";

/**
 * Keys the roster sync writes onto `attributes` as its own lifecycle bookkeeping, which are not
 * routing facts and so are never offered as bucket criteria (#3615): the Redistribute and
 * demotion marks' timestamps, their swept markers, the missing worker stamp, and the tiers held
 * before a demotion (which read exactly like real tiers). Built from the writers' own key
 * constants, so a renamed key follows, and `scripts/test-catalog.ts` checks it against what the
 * real mark helpers write. What it cannot see is a bookkeeping key added by some OTHER writer
 * with no constant here; such a key would show up in the picker until it is added.
 */
const SYNC_BOOKKEEPING_KEYS = new Set<string>([
  REDISTRIBUTE_AT_KEY,
  REDISTRIBUTE_SWEPT_KEY,
  TWILIO_WORKER_MISSING_KEY,
  DEMOTION_MARK_KEY,
  DEMOTION_SWEPT_KEY,
  DEMOTION_FROM_DEBT_KEY,
  DEMOTION_FROM_BACKEND_KEY,
]);

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
