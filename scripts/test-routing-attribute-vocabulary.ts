// The routing attribute vocabulary has ONE definition, and the sync that writes it
// maps onto it rather than beside it (#1874, and Twilio since #2152).
//
// `debt_team` and `backend_service` are what routing MATCHES on: a bucket's
// criteria come from `bucketSpecForXbc`, and an agent joins a pool only when
// their attribute values equal those keys. A value outside the vocabulary
// produces no error, it produces an agent who silently belongs to no bucket,
// and the only symptom is a pool one person shorter than expected.
//
// The admin form used to be a second, unvalidated way in (a text box with a
// placeholder). It is read only now, so the sync is the ONLY writer, and since
// #2152 that sync reads Twilio: an agent's tiers and backend come from their
// TaskRouter `teams` tags through `TEAM_TO_DEBT_TIER` and `TEAM_TO_BACKEND`. That
// mapping is the second spelling of the vocabulary, which is the same defect one
// layer down: adding a sixth tier to the routing table would leave the sync
// unable to produce it, so no agent could ever carry it and the new tier's
// buckets would be permanently empty.
//
// Asserted in BOTH directions on purpose, and at both joins. A one way check
// passes a mapping that emits values routing has never heard of, which is the typo
// case, and equally passes one missing a tier, which is the empty pool case. tsc
// covers only the first half at the Twilio join, because the mapping is keyed on
// the TAG: a tier no tag produces is a type error nowhere.
// Run: node --experimental-strip-types scripts/test-routing-attribute-vocabulary.ts
import { BACKEND, DEBT_TIER } from "../src/lib/xbc.ts";
import { BACKEND_VALUES, DEBT_TIER_VALUES } from "../src/lib/routing/attribute-vocabulary.ts";
import { TEAM_TO_BACKEND, TEAM_TO_DEBT_TIER } from "../src/lib/twilio/roster.ts";
import { assert, finish } from "./lib/harness.ts";

const routingTiers = new Set(Object.values(DEBT_TIER).map((t) => t.key));
const routingBackends = new Set(
  Object.values(BACKEND)
    .map((b) => b.key)
    // "None" and "Both" carry no key: they mean the route does not filter on
    // backend at all, so there is no attribute value for an agent to hold.
    .filter((k): k is string => k !== null),
);

const syncTiers = new Set(DEBT_TIER_VALUES);
const syncBackends = new Set(BACKEND_VALUES);

// What the WRITER can actually produce: the values on the far side of the Twilio
// tag mapping. Read from the shipped maps rather than restated, so a tag retired in
// the Pipedream workflow's copy of the mapping is caught here as a tier nothing can
// write (L41).
const writableTiers = new Set(Object.values(TEAM_TO_DEBT_TIER));
const writableBackends = new Set(Object.values(TEAM_TO_BACKEND));

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

// The second join (#2152): the vocabulary against what a Twilio tag can produce.
// The "every value is writable" direction is the one tsc cannot see, because the
// mapping is keyed on the tag, so a tier with no tag is a perfectly valid map and
// an agent who can never hold that tier.
for (const [name, vocabulary, writable] of [
  ["debt_team", syncTiers, writableTiers],
  ["backend_service", syncBackends, writableBackends],
] as const) {
  for (const v of vocabulary) {
    assert(
      writable.has(v),
      `${name}: no Twilio tag maps to "${v}", so no agent can ever hold it and its buckets are permanently empty`,
    );
  }
  for (const v of writable) {
    assert(
      vocabulary.has(v),
      `${name}: a Twilio tag maps to "${v}", which is not a routing value, so it would silently belong to no bucket`,
    );
  }
}

finish();
