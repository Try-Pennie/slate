// The routing attribute vocabulary has ONE definition, and the Salesforce sync
// maps onto it rather than beside it (#1874).
//
// `debt_team` and `backend_service` are what routing MATCHES on: a bucket's
// criteria come from `bucketSpecForXbc`, and an agent joins a pool only when
// their attribute values equal those keys. A value outside the vocabulary
// produces no error, it produces an agent who silently belongs to no bucket,
// and the only symptom is a pool one person shorter than expected.
//
// The admin form used to be a second, unvalidated way in (a text box with a
// placeholder). It is read only now, so the sync is the ONLY writer, and the
// sync builds its values from a hardcoded map of Salesforce field names. That
// map is the second spelling of the vocabulary, which is the same defect one
// layer down: adding a sixth tier to the routing table would leave the sync
// unable to produce it, so no agent could ever carry it and the new tier's
// buckets would be permanently empty.
//
// Asserted in BOTH directions on purpose. A one way check passes a map that
// emits values routing has never heard of, which is the typo case, and equally
// passes a map missing a tier, which is the empty pool case.
// Run: node --experimental-strip-types scripts/test-routing-attribute-vocabulary.ts
import { BACKEND, DEBT_TIER } from "../src/lib/xbc.ts";
import { SF_BACKEND_VALUES, SF_DEBT_VALUES } from "../src/lib/salesforce/sync-vocabulary.ts";
import { assert, finish } from "./lib/harness.ts";

const routingTiers = new Set(Object.values(DEBT_TIER).map((t) => t.key));
const routingBackends = new Set(
  Object.values(BACKEND)
    .map((b) => b.key)
    // "None" and "Both" carry no key: they mean the route does not filter on
    // backend at all, so there is no attribute value for an agent to hold.
    .filter((k): k is string => k !== null),
);

const syncTiers = new Set(SF_DEBT_VALUES);
const syncBackends = new Set(SF_BACKEND_VALUES);

for (const [name, routing, sync] of [
  ["debt_team", routingTiers, syncTiers],
  ["backend_service", routingBackends, syncBackends],
] as const) {
  for (const v of routing) {
    assert(sync.has(v), `${name}: routing matches on "${v}", so the sync must be able to write it`);
  }
  for (const v of sync) {
    assert(
      routing.has(v),
      `${name}: the sync can write "${v}", so routing must match on it or no bucket ever will`,
    );
  }
  assert(
    routing.size === sync.size,
    `${name}: the two vocabularies are the same size (routing ${routing.size}, sync ${sync.size})`,
  );
}

// A guard whose expected values came from the thing under test proves only that
// the thing agrees with itself (L70), so the counts are stated here as well.
assert(routingTiers.size === 5, "five debt tiers, as the XBC's first digit allows");
assert(routingBackends.size === 2, "two backend servicers that an agent can actually hold");

finish();
