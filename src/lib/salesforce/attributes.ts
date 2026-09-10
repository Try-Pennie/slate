import type { Attributes } from "@/lib/db/types";

/**
 * Pure: merge freshly-synced Salesforce attributes over an agent's existing
 * ones (#66). Salesforce OWNS its keys: they are replaced wholesale each sync,
 * including removal when a flag was un-checked in SF, while every other key
 * survives. Before this, the sync replaced the whole attributes object and wiped
 * Slate-managed routing data on every run.
 *
 * IT OWNS ONE KEY NOW. `debt_team` and `backend_service` left this list in #2152,
 * when Twilio TaskRouter became the source of both: the tags there are what feeds
 * cal.com, and Salesforce was a second copy of the same facts that nothing
 * reconciled. Leaving them here would have been worse than pointless, because
 * this list DELETES before it merges, so the Salesforce half of an hourly run
 * would strip whatever the Twilio half had written.
 *
 * The keys that survive a Salesforce sync are therefore everything Twilio owns
 * (`debt_team`, `backend_service` and the `redistribute` mark),
 * and the ordering that makes that safe is in `run-roster-sync.ts`: Salesforce
 * runs first, Twilio second, inside one lock.
 */
export const SF_MANAGED_KEYS = ["role"] as const;

export function mergeSfAttributes(
  existing: Attributes | null | undefined,
  fromSf: Attributes,
): Attributes {
  const merged: Attributes = { ...(existing ?? {}) };
  for (const key of SF_MANAGED_KEYS) delete merged[key];
  return { ...merged, ...fromSf };
}
