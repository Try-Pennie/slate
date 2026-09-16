// Which roster rows Salesforce no longer confirms, and why (#1833).
//
// The roster query returns the people Salesforce still matches. Everybody else in
// Slate is simply never written again, and that is the whole defect: their stored
// attributes freeze at whatever the last matching run wrote while the hourly lane
// reports success every hour. These are the pure decisions behind reporting them.
//
// Since #2387 the CAUSE comes from a standing read once by
// `readSalesforceStanding` and shared with the reap, so this file drives standings
// rather than a presence map. The reading itself, and the proof that the two
// halves agree about one address, live in scripts/test-salesforce-presence.ts.
//
// Run: node --experimental-strip-types scripts/test-roster-divergence.ts
import type { SalesforceStanding } from "../src/lib/salesforce/presence.ts";
import {
  planRosterDivergence,
  scanForDivergence,
  type DivergenceScan,
  type RosterRowForDivergence,
} from "../src/lib/salesforce/roster-divergence.ts";
import { eq, finish } from "./lib/harness.ts";

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

/** Attach a standing to every candidate, the way the sync does. */
function withStandings(
  scan: DivergenceScan,
  by: Record<string, SalesforceStanding>,
  fallback: SalesforceStanding = "absent",
) {
  return {
    examined: scan.examined,
    candidates: scan.candidates.map((c) => ({
      ...c,
      standing: by[c.email] ?? fallback,
    })),
  };
}

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

// --- the four causes, each its own ------------------------------------------

const fourRows = [
  row({ id: "u-inactive", email: "left@trypennie.com" }),
  row({ id: "u-unmatched", email: "onleave@trypennie.com" }),
  row({ id: "u-absent", email: "never@trypennie.com" }),
  row({ id: "u-ambiguous", email: "shared@trypennie.com" }),
];
const fourScan = scanForDivergence(fourRows, noRoster);
eq(fourScan.candidates.length, 4, "every unmatched in scope row is a candidate");

const plan = planRosterDivergence(
  withStandings(fourScan, {
    "left@trypennie.com": "departed",
    "onleave@trypennie.com": "held",
    "never@trypennie.com": "absent",
    "shared@trypennie.com": "ambiguous",
  }),
);

eq(plan.examined, 4, "the plan carries how many rows were reconciled, so zero is visible");
eq(plan.inactive, 1, "a row Salesforce holds as inactive is counted as inactive");
eq(plan.unmatched, 1, "a row active in Salesforce and outside the roster criteria is counted as unmatched");
eq(plan.absent, 1, "a row Salesforce returned no record for at all is counted as absent");
eq(plan.ambiguous, 1, "an address nothing can settle is counted apart from all three verdicts");
eq(
  plan.rows.map((r) => `${r.userId}:${r.cause}`).sort(),
  [
    "u-absent:absent",
    "u-ambiguous:ambiguous",
    "u-inactive:inactive",
    "u-unmatched:unmatched",
  ],
  "each row carries its own cause, so one message never answers for another",
);
eq(
  plan.inactive + plan.unmatched + plan.absent + plan.ambiguous,
  plan.rows.length,
  "every row lands in exactly one cause bucket",
);

{
  // A shared address with an active AND an inactive Salesforce record, and no
  // stored key to say which is this row's. It used to read as `unmatched` here
  // (active wins) while the reap read the same address as a departure and
  // deactivated the person. Now both refuse, and the refusal is its own count.
  const both = planRosterDivergence(
    withStandings(
      scanForDivergence([row({ id: "u-both", email: "shared@trypennie.com" })], noRoster),
      { "shared@trypennie.com": "ambiguous" },
    ),
  );
  eq(both.ambiguous, 1, "an unsettleable address is reported as such");
  eq(both.unmatched, 0, "never as somebody Salesforce still holds");
  eq(both.inactive, 0, "and never as a departure, which is what deactivated a rehire");
}

// --- the bookable subset, which is the part that misroutes a lead ------------

{
  const p = planRosterDivergence(
    withStandings(
      scanForDivergence(
        [
          row({ id: "u-live", email: "live@trypennie.com", bookable: true }),
          row({ id: "u-quiet", email: "quiet@trypennie.com", bookable: false }),
        ],
        noRoster,
      ),
      { "live@trypennie.com": "held", "quiet@trypennie.com": "held" },
    ),
  );
  eq(p.unmatched, 2, "both rows are unconfirmed");
  eq(p.bookable, ["live@trypennie.com"], "only the bookable one is named as still routable");
}

// --- a read that told us nothing must never read as a healthy roster --------

{
  // The shape of a Salesforce read that came back empty. Every candidate is
  // ABSENT, which is a finding; it can never be mistaken for nobody diverging,
  // because the candidate list was built before the read and does not shrink.
  const p = planRosterDivergence(withStandings(fourScan, {}));
  eq(p.absent, 4, "an empty presence answer reports every candidate, never an all clear");
  eq(p.rows.length, 4, "and no row is dropped for want of an answer");
}

{
  const p = planRosterDivergence({ examined: 0, candidates: [] });
  eq(p.examined, 0, "nothing reconciled is reported as nothing reconciled");
  eq(p.rows.length, 0, "and it produces no findings, which is why the examined count has to be read beside it");
}

finish();
