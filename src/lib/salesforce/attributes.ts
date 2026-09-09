import type { Attributes } from "@/lib/db/types";

/**
 * Pure: merge freshly-synced Salesforce attributes over an agent's existing
 * ones (#66). Salesforce OWNS its keys: they are replaced wholesale each sync,
 * including removal when a flag was un-checked in SF, while every other key
 * survives. Before this, the sync replaced the whole attributes object and wiped
 * Slate-managed routing data on every run.
 *
 * The key that survives today is `legal_eligible`, and #2120 changed WHO writes
 * it. An admin used to, through a control on the agent page; that control wrote
 * a boolean routing could never act on (it matches the string "N"), and it was a
 * second place to set a fact that lives in Twilio as the `Not Legal Eligible`
 * tag, which is how cal.com is fed. So it is gone, and this key now waits for the
 * Twilio sync to write it rather than for a person.
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
