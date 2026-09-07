// The membership half of `pnpm verify:calcom-parity` (#1911). Run:
//   node --experimental-strip-types scripts/test-roster-parity.ts
//
// WHY IT EXISTS. Both systems hold the same roster during the parallel run and
// nothing reconciled them, so one could be six weeks ahead of the other with no
// signal. The case that produced this issue: Slate deactivated an agent on
// 2026-07-21 and had no Low plus Beyond agent from that date, while cal.com went
// on routing her every Low plus Beyond lead for another six weeks (28 of 28
// bookings between 08-26 and 09-03). She was then removed from the cal.com org,
// leaving 11 upcoming calls with a host who no longer existed there.
//
// The two failures are opposite and both were invisible. cal.com was sending real
// leads to a departed agent; Slate was silently missing the one agent who could
// serve those buckets. The hours comparison cannot see either, because it only
// looks at agents who ARE bookable in Slate: a bucket empty in Slate and served by
// one person in cal.com reads as ordinary under-offering.
//
// NOT EVERY DIVERGENCE IS A PROBLEM, and getting that wrong is how this check
// would end up ignored. Measured live 2026-09-07: 115 hosts on the review event
// type against 102 bookable Slate agents, and 9 of the 13 extra are admins,
// managers and team leads who are deliberately not bookable in Slate. Paging on
// those daily would bury the two that matter, which is the same trap the hours
// comparison hit with cosmetic timezone names.
import {
  classifyRosterMember,
  compareRosters,
  worstRosterVerdict,
  ROSTER_VERDICT_RANK,
  type SlateRosterMember,
} from "./lib/roster-parity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A Slate user as the comparison sees them. Defaults are the ordinary case, so
 *  each test states only what makes its own case different. */
function slate(over: Partial<SlateRosterMember> = {}): SlateRosterMember {
  return {
    email: "someone@trypennie.com",
    role: "agent",
    bookable: true,
    deactivatedAt: null,
    isTest: false,
    hasRoutingAttributes: true,
    ...over,
  };
}

// --- the ordinary case ---------------------------------------------------------
{
  const r = classifyRosterMember(slate(), true);
  eq(r.verdict, "agree", "a bookable Slate agent who hosts in cal.com is the healthy case");
}
{
  const r = classifyRosterMember(null, true);
  eq(r.verdict, "absent-from-slate", "a cal.com host Slate has never heard of cannot be reconciled");
}

// --- the case this issue was filed for ------------------------------------------
{
  // The agent who left on 2026-07-21. Slate knows she is gone; cal.com kept
  // routing her real leads for six weeks. This is the one that must outrank
  // everything else, because it is the only one that books somebody who has left.
  const r = classifyRosterMember(slate({ deactivatedAt: "2026-07-21T00:00:00Z", bookable: false }), true);
  eq(r.verdict, "departed-still-hosting", "somebody who has left Slate and still hosts in cal.com is the worst finding");
  assert(r.reason.includes("2026-07-21"), "and the reason carries the date they left, so nobody has to go and look it up");
}
{
  // Deactivated in Slate AND already removed from cal.com. Nothing to report: the
  // two systems agree that this person is gone.
  const r = classifyRosterMember(slate({ deactivatedAt: "2026-07-21T00:00:00Z", bookable: false }), false);
  eq(r.verdict, "agree", "somebody gone from both systems is agreement, not a finding");
}

// --- an agent held back in Slate who cal.com can still route --------------------
{
  // rvillar@ today: became a manager, set non-bookable in Slate on 2026-09-02, and
  // still a host on the review event type. Not as bad as a departure, because they
  // are still employed and reachable, but cal.com can put a real lead on them.
  const r = classifyRosterMember(slate({ bookable: false }), true);
  eq(r.verdict, "held-back-still-hosting", "an agent Slate will not route who cal.com still can is a finding");
  assert(
    r.reason.includes("cal.com can still route"),
    "and the reason says what the consequence is rather than only naming the state",
  );
}
{
  // The same shape with NO routing attributes cannot actually receive a lead
  // through attribute routing, so it is reported quietly rather than as a risk.
  // Attributes are read from Slate because cal.com does not expose per-user
  // attribute values: `/organizations/{org}/users/{id}/attributes` answers 404.
  const r = classifyRosterMember(slate({ bookable: false, hasRoutingAttributes: false }), true);
  eq(r.verdict, "not-bookable-by-design", "an agent with no routing attributes cannot be routed to, so it is not a risk");
}

// --- the expected nine -----------------------------------------------------------
{
  // Admins, managers, team leads and the super admin are hosts in cal.com and
  // deliberately not bookable in Slate. Nine of them today. They are reported so
  // the roster can be read in full, and they must never be able to fail a run:
  // a check that is red every day for a reason nobody should fix stops being read.
  for (const role of ["admin", "manager", "team_lead", "super_admin"]) {
    const r = classifyRosterMember(slate({ role, bookable: false }), true);
    eq(r.verdict, "staff-not-bookable", `a ${role} hosting in cal.com is expected, not a finding`);
    // The report is read by people, and half these roles begin with a vowel.
    assert(
      r.reason.startsWith(/^[aeiou]/i.test(role) ? "an " : "a "),
      `the reason for a ${role} reads as English (${r.reason.slice(0, 20)})`,
    );
    assert(!r.reason.includes("_"), `and the role is spelled out rather than shown as a column value (${role})`);
  }
}
{
  // The rank is what actually keeps them quiet, so it is asserted rather than
  // assumed: equal to agreement, so a sweep of nothing but staff exits zero.
  eq(
    ROSTER_VERDICT_RANK["staff-not-bookable"],
    ROSTER_VERDICT_RANK.agree,
    "staff rank level with agreement, so they can never name a run",
  );
  assert(
    ROSTER_VERDICT_RANK["departed-still-hosting"] > ROSTER_VERDICT_RANK["held-back-still-hosting"],
    "a departure outranks somebody merely held back",
  );
}
{
  // A departed ADMIN is still a departure. Ranking by role first would let the
  // worst finding hide behind the quietest category.
  const r = classifyRosterMember(
    slate({ role: "admin", bookable: false, deactivatedAt: "2026-08-01T00:00:00Z" }),
    true,
  );
  eq(r.verdict, "departed-still-hosting", "leaving outranks the role, so a departed admin is not filed as expected");
}

// --- the other direction ---------------------------------------------------------
{
  // Slate offering somebody cal.com never routes. Zero today, and worth catching:
  // it means Slate is putting a name in front of leads that the incumbent does not.
  const r = classifyRosterMember(slate(), false);
  eq(r.verdict, "bookable-not-hosting", "a bookable Slate agent absent from cal.com's host list is a finding");
}
{
  // Test agents are Slate's own smoke fixtures (#396) and have no cal.com identity
  // by design. Reporting them would make the sweep permanently red on purpose.
  const r = classifyRosterMember(slate({ isTest: true }), false);
  eq(r.verdict, "agree", "a test agent absent from cal.com is expected");
}

// --- the sweep -------------------------------------------------------------------
{
  const result = compareRosters(
    [
      slate({ email: "a@trypennie.com" }),
      slate({ email: "b@trypennie.com", bookable: false, deactivatedAt: "2026-07-21T00:00:00Z" }),
      slate({ email: "c@trypennie.com", role: "admin", bookable: false }),
    ],
    new Set(["a@trypennie.com", "b@trypennie.com", "c@trypennie.com", "ghost@trypennie.com"]),
  );
  eq(result.rows.length, 4, "every agent on either side is accounted for, including one Slate has never seen");
  eq(
    result.rows.find((r) => r.email === "ghost@trypennie.com")?.verdict,
    "absent-from-slate",
    "a host with no Slate row is carried through rather than dropped",
  );
  eq(worstRosterVerdict(result.rows.map((r) => r.verdict)), "departed-still-hosting", "the sweep is named by its worst row");
}
{
  // Case matters, because the two systems disagree about it and an unmatched
  // address is reported as somebody missing from a roster they are actually on.
  const result = compareRosters([slate({ email: "Mixed.Case@TryPennie.com" })], new Set(["mixed.case@trypennie.com"]));
  eq(result.rows[0].verdict, "agree", "addresses match without regard to case");
}
{
  // An empty host list is never agreement. cal.com answering with no hosts, or an
  // event type that has moved, would otherwise read as every Slate agent being
  // absent from cal.com, which is a hundred findings about one broken read (L98).
  const result = compareRosters([slate()], new Set());
  assert(result.hostsEmpty, "no hosts at all is flagged as its own condition, not scored as a hundred divergences");
}
{
  eq(worstRosterVerdict([]), null, "an empty sweep is not agreement");
  eq(
    worstRosterVerdict(["agree", "staff-not-bookable"]),
    "agree",
    "a sweep of nothing but agreement and expected staff is a pass",
  );
}

finish();
