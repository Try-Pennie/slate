// The ONE reading of a shared Salesforce address (#2387).
//
// An email address can answer to more than one Salesforce User: measured against
// the live org on 2026-08-31, two addresses were shared by more than one ACTIVE
// record. Until this module there were two readings of that state either side of a
// module boundary, and in the same hourly run they said opposite things about the
// same address. The reap deactivated a rehire on the old record left inactive
// beside their new active one, while the roster reconcile counted the very same
// address as somebody Salesforce still holds.
//
// So the last block here is the one that matters most: it drives the reap and the
// reconcile through the SAME predicate and asserts they agree, rather than
// asserting each against a separate expectation written by hand (L70).
//
// Run: node --experimental-strip-types scripts/test-salesforce-presence.ts
import {
  presenceFromRecords,
  readSalesforceStanding,
  type SalesforcePresence,
  type SalesforceStanding,
} from "../src/lib/salesforce/presence.ts";
import { planReap } from "../src/lib/salesforce/reap.ts";
import {
  planRosterDivergence,
  scanForDivergence,
} from "../src/lib/salesforce/roster-divergence.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- folding Salesforce's answer into a presence map -------------------------

{
  const map = presenceFromRecords([
    { email: "A@Trypennie.com ", isActive: true, recordId: "005A" },
    { email: "b@trypennie.com", isActive: false, recordId: "005B1" },
    { email: "b@trypennie.com", isActive: true, recordId: "005B2" },
    { email: "", isActive: true, recordId: "005X" },
  ]);
  eq(
    map.get("a@trypennie.com"),
    { anyActive: true, anyInactive: false, activeIds: ["005A"], inactiveIds: [] },
    "addresses are normalised and the record id is kept",
  );
  eq(
    map.get("b@trypennie.com"),
    { anyActive: true, anyInactive: true, activeIds: ["005B2"], inactiveIds: ["005B1"] },
    "two records for one address keep both facts AND which id carries which",
  );
  assert(!map.has(""), "a record with no address contributes nothing");
}

{
  // The presence query is chunked, so an address can be asked about twice and the
  // same record can arrive twice. Counting it twice would not change a boolean,
  // but it would put the id in the list twice and make every count of it wrong.
  const map = presenceFromRecords([
    { email: "dup@trypennie.com", isActive: true, recordId: "005D" },
    { email: "dup@trypennie.com", isActive: true, recordId: "005D" },
  ]);
  eq(map.get("dup@trypennie.com")?.activeIds, ["005D"], "a repeated record is folded, not duplicated");
}

{
  // A response with no Id column at all still carries the activity, so the reading
  // degrades to the address wide one rather than to silence.
  const map = presenceFromRecords([{ email: "noid@trypennie.com", isActive: false }]);
  eq(
    map.get("noid@trypennie.com"),
    { anyActive: false, anyInactive: true, activeIds: [], inactiveIds: [] },
    "a record with no id still contributes its activity",
  );
}

// --- the reading itself ------------------------------------------------------

const shared: SalesforcePresence = {
  anyActive: true,
  anyInactive: true,
  activeIds: ["005NEW"],
  inactiveIds: ["005OLD"],
};
const onlyActive: SalesforcePresence = {
  anyActive: true,
  anyInactive: false,
  activeIds: ["005H"],
  inactiveIds: [],
};
const onlyInactive: SalesforcePresence = {
  anyActive: false,
  anyInactive: true,
  activeIds: [],
  inactiveIds: ["005G"],
};

eq(readSalesforceStanding(undefined, null), "absent", "no record at all is absent, never departed");
eq(
  readSalesforceStanding(undefined, "005NEW"),
  "absent",
  "and a stored id does not conjure a record Salesforce did not return",
);
eq(readSalesforceStanding(onlyActive, null), "held", "one active record is somebody Salesforce still holds");
eq(readSalesforceStanding(onlyInactive, null), "departed", "one inactive record is somebody who left");
eq(
  readSalesforceStanding(shared, "005NEW"),
  "held",
  "the stored id decides: a rehire whose key names the ACTIVE record is still held",
);
eq(
  readSalesforceStanding(shared, "005OLD"),
  "departed",
  "and the same address with the key naming the INACTIVE record is a departure",
);
eq(
  readSalesforceStanding(shared, null),
  "ambiguous",
  "no key and records that disagree is a REFUSAL, never a verdict either way (L521)",
);
eq(
  readSalesforceStanding(shared, "   "),
  "ambiguous",
  "a blank stored key is no key at all",
);
eq(
  readSalesforceStanding(shared, "005SOMEBODYELSE"),
  "ambiguous",
  "a key naming none of these records settles nothing, so it refuses too",
);
eq(
  readSalesforceStanding(onlyInactive, "005SOMEBODYELSE"),
  "departed",
  "but a key naming no record falls back to the address, and one inactive record is a departure",
);
eq(
  readSalesforceStanding(
    { anyActive: false, anyInactive: false, activeIds: [], inactiveIds: [] },
    null,
  ),
  "absent",
  "an entry holding no record is absent, not a verdict about nobody",
);

// --- the reap's own decisions ------------------------------------------------

{
  const plan = planReap([
    { id: "u-gone", email: "gone@trypennie.com", standing: "departed" },
    { id: "u-here", email: "here@trypennie.com", standing: "held" },
    { id: "u-never", email: "never@trypennie.com", standing: "absent" },
    { id: "u-shared", email: "shared@trypennie.com", standing: "ambiguous" },
  ]);
  eq(plan.deactivate, ["u-gone"], "only a departure is deactivated");
  eq(
    plan.refused,
    [{ userId: "u-shared", email: "shared@trypennie.com" }],
    "a shared address is CARRIED OUT as a refusal, so a reap that acted on nobody is not silent (L98)",
  );
}

{
  const plan = planReap([]);
  eq(plan.deactivate, [], "an empty candidate list deactivates nobody");
  eq(plan.refused, [], "and refuses nobody");
}

// --- the reap and the reconcile agree about one address ----------------------
//
// Driven through the shared predicate rather than against two expectations
// written here, because two expectations is exactly the shape that let the two
// readings drift apart in the first place (L70).

{
  const presence = presenceFromRecords([
    { email: "rehire@trypennie.com", isActive: true, recordId: "005NEW" },
    { email: "rehire@trypennie.com", isActive: false, recordId: "005OLD" },
    { email: "gone@trypennie.com", isActive: false, recordId: "005G" },
    { email: "shared@trypennie.com", isActive: true, recordId: "005S1" },
    { email: "shared@trypennie.com", isActive: false, recordId: "005S2" },
  ]);

  /** One person, as both halves of the sync see them. */
  const people = [
    { id: "u-rehire", email: "rehire@trypennie.com", storedId: "005NEW" },
    { id: "u-left", email: "rehire@trypennie.com", storedId: "005OLD" },
    { id: "u-gone", email: "gone@trypennie.com", storedId: null },
    { id: "u-shared", email: "shared@trypennie.com", storedId: null },
    { id: "u-never", email: "never@trypennie.com", storedId: null },
  ];
  const standingOf = (p: (typeof people)[number]): SalesforceStanding =>
    readSalesforceStanding(presence.get(p.email), p.storedId);

  const reap = planReap(
    people.map((p) => ({ id: p.id, email: p.email, standing: standingOf(p) })),
  );
  const scan = scanForDivergence(
    people.map((p) => ({
      id: p.id,
      email: p.email,
      bookable: false,
      deactivated: false,
      isTest: false,
    })),
    { emails: new Set<string>() },
  );
  const divergence = planRosterDivergence({
    examined: scan.examined,
    candidates: scan.candidates.map((c) => {
      const person = people.find((p) => p.id === c.id)!;
      return { ...c, standing: standingOf(person) };
    }),
  });

  const causeById = new Map(divergence.rows.map((r) => [r.userId, r.cause]));

  // Nobody the reconcile calls unmatched (Salesforce still holds them, active) may
  // be somebody the reap deactivated. That pairing IS the defect: one run wrote
  // the row from the active record and deactivated it on the inactive one.
  for (const id of reap.deactivate) {
    assert(
      causeById.get(id) === "inactive",
      `the reconcile calls ${id} inactive too, so the reap deactivating them is not contradicted in the same run`,
    );
  }
  // And a refusal on one side is a refusal on the other, rather than a verdict.
  for (const r of reap.refused) {
    assert(
      causeById.get(r.userId) === "ambiguous",
      `the reconcile refuses ${r.userId} too, rather than reaching a verdict the reap declined to reach`,
    );
  }

  eq(reap.deactivate, ["u-left", "u-gone"], "the rehire is kept and the two real departures go");
  eq(reap.refused.map((r) => r.userId), ["u-shared"], "and the unsettleable address is refused");
  eq(causeById.get("u-rehire"), "unmatched", "the rehire reads as somebody Salesforce still holds");
  eq(causeById.get("u-never"), "absent", "and an address Salesforce has no record of stays absent");
}

finish();
