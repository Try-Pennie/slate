/**
 * The routing attribute values an agent can hold (#1874).
 *
 * `debt_team` and `backend_service` are what routing MATCHES on: a bucket's
 * criteria come from `bucketSpecForXbc`, and an agent joins a pool only when
 * their attribute values equal those keys. A value outside this set produces no
 * error, it produces an agent who silently belongs to no bucket, and the only
 * symptom is a pool one person shorter than expected.
 *
 * Here, rather than in `sync.ts`, for two reasons that pull in opposite
 * directions and are both satisfied by splitting them:
 *
 * The SYNC's map is typed `Record<SfDebtValue, keyof SfUser>`, so tsc requires
 * exactly one Salesforce field per value: a value the vocabulary does not carry
 * is rejected, and a value it does carry cannot be forgotten. That is the typo
 * direction, enforced by the compiler at the only remaining write path (the admin
 * form is read only since #1874).
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
export const SF_DEBT_VALUES = ["ultra_high", "very_high", "high", "medium", "low"] as const;
export const SF_BACKEND_VALUES = ["beyond", "achieve"] as const;

export type SfDebtValue = (typeof SF_DEBT_VALUES)[number];
export type SfBackendValue = (typeof SF_BACKEND_VALUES)[number];
