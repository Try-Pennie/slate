// Which roster rows Salesforce no longer confirms, and why (#1833).
//
// The roster query returns the people Salesforce still matches. Everybody else in
// Slate is simply never written again, and that is the whole defect: their stored
// attributes freeze at whatever the last matching run wrote while the hourly lane
// reports success every hour. These are the pure decisions behind reporting them.
//
// Run: node --experimental-strip-types scripts/test-roster-divergence.ts
import {
  planRosterDivergence,
  presenceFromRecords,
  scanForDivergence,
  type RosterRowForDivergence,
  type SalesforcePresence,
} from "../src/lib/salesforce/roster-divergence.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function row(over: Partial<RosterRowForDivergence> = {}): RosterRowForDivergence {
  return {
    id: "u1",
    email: "agent@trypennie.com",
    bookable: false,
    deactivated: false,
    isTest: false,
    ...over,
  };
}

const noRoster = { emails: new Set<string>() };

// --- who is even a candidate -------------------------------------------------

{
  const scan = scanForDivergence([row()], {
    emails: new Set(["agent@trypennie.com"]),
  });
  eq(scan.candidates.length, 0, "a row the roster query returned by email is not a candidate");
  eq(scan.examined, 1, "and it still counts as examined");
}

{
  // The address changed in Salesforce, so the roster pass inserted a SECOND row
  // under the new one and this row holds an address Salesforce no longer has.
  // Reported, deliberately: the stored Salesforce user id is not consulted here,
  // because letting it confirm this row would hide the duplicate.
  const scan = scanForDivergence([row({ email: "old@trypennie.com" })], {
    emails: new Set(["new@trypennie.com"]),
  });
  eq(scan.candidates.length, 1, "a row whose address Salesforce no longer returns IS a candidate");
}

{
  const scan = scanForDivergence([row({ email: "AGENT@Trypennie.com " })], {
    emails: new Set(["agent@trypennie.com"]),
  });
  eq(scan.candidates.length, 0, "the address comparison is normalised on both sides");
}

{
  const scan = scanForDivergence(
    [
      row({ id: "gone", deactivated: true }),
      row({ id: "smoke", email: "smoke@trypennie.com", isTest: true }),
    ],
    noRoster,
  );
  eq(scan.candidates.length, 0, "a deactivated row and a smoke test row are out of scope");
  eq(scan.examined, 0, "and neither counts as examined, because neither was reconciled");
}

{
  const scan = scanForDivergence([row({ email: "  " })], noRoster);
  eq(scan.candidates.length, 0, "a row with no usable address cannot be asked about, so it is not a candidate");
}

// --- the three causes, each its own -----------------------------------------

const threeRows = [
  row({ id: "u-inactive", email: "left@trypennie.com" }),
  row({ id: "u-unmatched", email: "onleave@trypennie.com" }),
  row({ id: "u-absent", email: "never@trypennie.com" }),
];
const threeScan = scanForDivergence(threeRows, noRoster);
eq(threeScan.candidates.length, 3, "every unmatched in scope row is a candidate");

const presence = new Map<string, SalesforcePresence>([
  ["left@trypennie.com", { anyActive: false, anyInactive: true }],
  ["onleave@trypennie.com", { anyActive: true, anyInactive: false }],
  // never@ is deliberately absent from the map: Salesforce returned no record.
]);
const plan = planRosterDivergence(threeScan, presence);

eq(plan.examined, 3, "the plan carries how many rows were reconciled, so zero is visible");
eq(plan.inactive, 1, "a row Salesforce holds as inactive is counted as inactive");
eq(plan.unmatched, 1, "a row active in Salesforce and outside the roster criteria is counted as unmatched");
eq(plan.absent, 1, "a row Salesforce returned no record for at all is counted as absent");
eq(
  plan.rows.map((r) => `${r.userId}:${r.cause}`).sort(),
  ["u-absent:absent", "u-inactive:inactive", "u-unmatched:unmatched"],
  "each row carries its own cause, so one message never answers for another",
);
eq(
  plan.inactive + plan.unmatched + plan.absent,
  plan.rows.length,
  "every row lands in exactly one cause bucket",
);

{
  // A shared address with an active AND an inactive Salesforce record. Active
  // wins for the divergence reading: somebody Salesforce still holds as active is
  // not somebody who left.
  const both = planRosterDivergence(
    scanForDivergence([row({ id: "u-both", email: "shared@trypennie.com" })], noRoster),
    new Map([["shared@trypennie.com", { anyActive: true, anyInactive: true }]]),
  );
  eq(both.unmatched, 1, "an address with an active record is unmatched, not inactive");
  eq(both.inactive, 0, "and it is not counted as inactive as well, which would double count one person");
}

// --- the bookable subset, which is the part that misroutes a lead ------------

{
  const p = planRosterDivergence(
    scanForDivergence(
      [
        row({ id: "u-live", email: "live@trypennie.com", bookable: true }),
        row({ id: "u-quiet", email: "quiet@trypennie.com", bookable: false }),
      ],
      noRoster,
    ),
    new Map([
      ["live@trypennie.com", { anyActive: true, anyInactive: false }],
      ["quiet@trypennie.com", { anyActive: true, anyInactive: false }],
    ]),
  );
  eq(p.unmatched, 2, "both rows are unconfirmed");
  eq(p.bookable, ["live@trypennie.com"], "only the bookable one is named as still routable");
}

// --- a read that told us nothing must never read as a healthy roster --------

{
  // The shape of a Salesforce read that came back empty. Every candidate is
  // ABSENT, which is a finding; it can never be mistaken for nobody diverging,
  // because the candidate list was built before the read and does not shrink.
  const p = planRosterDivergence(threeScan, new Map<string, SalesforcePresence>());
  eq(p.absent, 3, "an empty presence map reports every candidate, never an all clear");
  eq(p.rows.length, 3, "and no row is dropped for want of an answer");
}

{
  const p = planRosterDivergence({ examined: 0, candidates: [] }, new Map());
  eq(p.examined, 0, "nothing reconciled is reported as nothing reconciled");
  eq(p.rows.length, 0, "and it produces no findings, which is why the examined count has to be read beside it");
}

// --- folding the Salesforce records into a presence map ---------------------

{
  const map = presenceFromRecords([
    { email: "A@Trypennie.com ", isActive: true },
    { email: "b@trypennie.com", isActive: false },
    { email: "b@trypennie.com", isActive: true },
    { email: "", isActive: true },
  ]);
  eq(map.get("a@trypennie.com"), { anyActive: true, anyInactive: false }, "addresses are normalised");
  eq(
    map.get("b@trypennie.com"),
    { anyActive: true, anyInactive: true },
    "two records for one address keep BOTH facts, so the reap's any-inactive rule survives unchanged",
  );
  assert(!map.has(""), "a record with no address contributes nothing");
}

finish();
