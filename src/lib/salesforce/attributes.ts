import type { Attributes } from "@/lib/db/types";

/**
 * Pure: merge freshly-synced Salesforce attributes over an agent's existing
 * ones (#66). Salesforce OWNS its keys - they are replaced wholesale each
 * sync, including removal when a flag was un-checked in SF - while keys
 * managed inside Slate (legal_eligible today; anything else an admin sets)
 * survive. Before this, the sync replaced the whole attributes object and
 * wiped Slate-managed routing data on every run.
 */
export const SF_MANAGED_KEYS = ["debt_team", "backend_service", "role"] as const;

export function mergeSfAttributes(
  existing: Attributes | null | undefined,
  fromSf: Attributes,
): Attributes {
  const merged: Attributes = { ...(existing ?? {}) };
  for (const key of SF_MANAGED_KEYS) delete merged[key];
  return { ...merged, ...fromSf };
}
