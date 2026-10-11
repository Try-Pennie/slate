/**
 * The routing attribute values an agent can hold (#1874).
 *
 * `debt_team` and `backend_service` are what routing MATCHES on: a bucket's
 * criteria come from `bucketSpecForXbc`, and an agent joins a pool only when
 * their attribute values equal those keys. A value outside this set produces no
 * error, it produces an agent who silently belongs to no bucket, and the only
 * symptom is a pool one person shorter than expected.
 *
 * It lived under `salesforce/` until #2152, when Twilio became the source of
 * both facts. The names moved with it: a vocabulary called `SF_*` that Salesforce
 * no longer writes tells every later reader the wrong thing about who owns it
 * (L176).
 *
 * Here, rather than in the sync that writes it, for two reasons that pull in
 * opposite directions and are both satisfied by splitting them:
 *
 * The WRITER's map is typed `Record<string, DebtTierValue>`, so tsc rejects a
 * Twilio tag mapped to a tier routing has never heard of. That is the typo
 * direction, enforced by the compiler at the only remaining write path (the admin
 * form is read only since #1874, and Salesforce stopped writing these keys in
 * #2152). The other direction, a tier no Twilio tag can produce, is a test rather
 * than a type, because the mapping is keyed on the tag: see
 * `scripts/test-twilio-parity.ts`.
 *
 * And this module imports NOTHING, so `scripts/test-routing-attribute-vocabulary.ts`
 * can hold it against the routing vocabulary in `xbc.ts` without pulling a
 * Supabase client into a node test. That is the other direction: a sixth tier
 * added to routing and not here could never reach an agent, so its buckets would
 * be permanently empty and nothing would say so.
 *
 * The ORDER is the order the values land in an agent's stored array, highest debt
 * first, which is why this is a list rather than a set.
 */
export const DEBT_TIER_VALUES = ["ultra_high", "very_high", "high", "medium", "low"] as const;
export const BACKEND_VALUES = ["beyond", "achieve"] as const;

export type DebtTierValue = (typeof DEBT_TIER_VALUES)[number];
export type BackendValue = (typeof BACKEND_VALUES)[number];

/** How each debt tier and backend reads to a person (#3615). A `Record` over the vocabulary, so
 *  `tsc` names a value somebody adds above and forgets here. */
export const DEBT_TIER_LABELS: Record<DebtTierValue, string> = {
  ultra_high: "Ultra High",
  very_high: "Very High",
  high: "High",
  medium: "Medium",
  low: "Low",
};
export const BACKEND_LABELS: Record<BackendValue, string> = {
  beyond: "Beyond",
  achieve: "Achieve",
};
