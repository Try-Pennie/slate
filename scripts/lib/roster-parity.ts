// The membership half of `pnpm verify:calcom-parity` (#1911). Pure: no network, no
// clock, no database, so `scripts/test-roster-parity.ts` drives every verdict
// offline.
//
// THE QUESTION. Both systems hold the same roster during the parallel run and
// nothing reconciled them, so one can be six weeks ahead of the other with no
// signal. Slate deactivated an agent on 2026-07-21 and had no Low plus Beyond
// agent from that date; cal.com went on routing her every Low plus Beyond lead
// for another six weeks, 28 of 28 bookings, and then she was removed from the org
// leaving 11 upcoming calls with a host who no longer existed. Both failures were
// invisible from inside either system.
//
// WHY THE HOURS COMPARISON CANNOT ANSWER IT. That one iterates the agents who ARE
// bookable in Slate, so somebody missing from Slate is not in the loop at all, and
// a bucket empty in Slate but served by one person in cal.com reads as ordinary
// under-offering rather than as a missing agent.
//
// NOT EVERY DIVERGENCE IS A PROBLEM. Measured live 2026-09-07: 115 hosts on the
// review event type against 102 bookable Slate agents, and 9 of the 13 extra are
// admins, managers and team leads deliberately not bookable in Slate. Those rank
// level with agreement and can never fail a run, because a check that is red every
// day for a reason nobody should fix is a check nobody reads (L36). That is the
// same trap the hours comparison hit with cosmetic timezone names, one issue
// earlier, which is why it is designed in here rather than discovered again.

/** A Slate user as this comparison needs them. */
export interface SlateRosterMember {
  email: string;
  role: string;
  bookable: boolean;
  /** Offboarding marker: set means they have left. */
  deactivatedAt: string | null;
  isTest: boolean;
  /**
   * Whether they carry Salesforce routing attributes, so a bucket could match
   * them at all.
   *
   * Read from SLATE rather than cal.com because cal.com does not expose per-user
   * attribute values: `/organizations/{org}/users/{id}/attributes` answers 404
   * (measured 2026-09-07). Both systems take the roster from Salesforce, so
   * Slate's copy is the same fact rather than a substitute for it.
   */
  hasRoutingAttributes: boolean;
}

export type RosterVerdict =
  /** The two systems say the same thing about this person. */
  | "agree"
  /** An admin, manager or team lead who hosts in cal.com and is deliberately not
   *  bookable in Slate. Expected, and can never fail a run. */
  | "staff-not-bookable"
  /** Not bookable in Slate, hosts in cal.com, and carries no routing attributes,
   *  so no bucket could match them. Worth closing, not worth paging. */
  | "not-bookable-by-design"
  /** A cal.com host with no Slate row at all, so nothing can reconcile them. */
  | "absent-from-slate"
  /** Slate offers somebody cal.com does not route to. */
  | "bookable-not-hosting"
  /** An agent Slate will not route who cal.com still can. */
  | "held-back-still-hosting"
  /** They have left, and cal.com can still book them. The reason this exists. */
  | "departed-still-hosting";

/**
 * Worst last.
 *
 * `staff-not-bookable` sits LEVEL WITH AGREEMENT rather than just above it, and
 * that is deliberate: there are nine of them today, they are correct, and nothing
 * will ever change them. Given a rank of their own they would fail every run
 * forever, and a permanently red check is one nobody reads by the second week.
 *
 * Departure outranks everything, including role, because it is the only state
 * that puts a real lead in front of somebody who has gone.
 */
export const ROSTER_VERDICT_RANK: Record<RosterVerdict, number> = {
  agree: 0,
  "staff-not-bookable": 0,
  "not-bookable-by-design": 1,
  "absent-from-slate": 2,
  "bookable-not-hosting": 3,
  "held-back-still-hosting": 4,
  "departed-still-hosting": 5,
};

/** The roles that are hosts in cal.com and deliberately not bookable in Slate. */
const STAFF_ROLES = new Set(["admin", "manager", "team_lead", "super_admin"]);

/** "a manager", "an admin". Computed rather than hardcoded to "a", because half
 *  the roles this reports on begin with a vowel and the report is read by people. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export interface RosterRow {
  email: string;
  verdict: RosterVerdict;
  reason: string;
}

/**
 * What the two systems say about one person, and what somebody should do.
 *
 * The order of the checks is the design. Leaving is asked FIRST, before the role,
 * because ranking by role would let the worst finding hide inside the quietest
 * category: a departed admin is a departure, not an expected staff account.
 */
export function classifyRosterMember(
  slate: SlateRosterMember | null,
  isCalcomHost: boolean,
): { verdict: RosterVerdict; reason: string } {
  if (slate === null) {
    return isCalcomHost
      ? {
          verdict: "absent-from-slate",
          reason: "hosts in cal.com and has no Slate record at all, so neither system can reconcile them",
        }
      : { verdict: "agree", reason: "" };
  }

  if (slate.deactivatedAt !== null) {
    return isCalcomHost
      ? {
          verdict: "departed-still-hosting",
          reason:
            `left Slate on ${slate.deactivatedAt.slice(0, 10)} and is still a host in cal.com, ` +
            "so real leads can still be booked with them",
        }
      : { verdict: "agree", reason: "" };
  }

  // Slate's own smoke fixtures (#396) have no cal.com identity by design, so
  // reporting them would make the sweep permanently red on purpose.
  if (slate.isTest) return { verdict: "agree", reason: "" };

  if (slate.bookable) {
    return isCalcomHost
      ? { verdict: "agree", reason: "" }
      : {
          verdict: "bookable-not-hosting",
          reason: "bookable in Slate and not a host in cal.com, so Slate offers somebody the incumbent never routes to",
        };
  }

  if (!isCalcomHost) return { verdict: "agree", reason: "" };

  if (STAFF_ROLES.has(slate.role)) {
    return {
      verdict: "staff-not-bookable",
      reason: `${article(slate.role)} ${slate.role.replace(/_/g, " ")} who hosts in cal.com and is deliberately not bookable in Slate`,
    };
  }
  if (!slate.hasRoutingAttributes) {
    return {
      verdict: "not-bookable-by-design",
      reason: "not bookable in Slate and hosts in cal.com, but carries no routing attributes, so no bucket can match them",
    };
  }
  return {
    verdict: "held-back-still-hosting",
    reason: "not bookable in Slate while cal.com can still route them a lead, and they carry routing attributes",
  };
}

export interface RosterComparison {
  rows: RosterRow[];
  /**
   * Whether cal.com named NO hosts at all.
   *
   * Kept as its own fact rather than left to fall out of the rows, because a host
   * list that came back empty (a moved event type, a refused read, a changed
   * payload) turns every bookable Slate agent into `bookable-not-hosting`: a
   * hundred findings about one broken read, and the caller has to refuse rather
   * than report them (L98).
   */
  hostsEmpty: boolean;
}

/**
 * Everybody either system knows about, classified.
 *
 * Addresses are matched case insensitively, because the two systems disagree
 * about case and an unmatched address is reported as somebody missing from a
 * roster they are in fact on.
 */
export function compareRosters(
  slateMembers: SlateRosterMember[],
  calcomHostEmails: Set<string>,
): RosterComparison {
  const hosts = new Set([...calcomHostEmails].map((e) => e.toLowerCase()));
  const rows: RosterRow[] = [];
  const seen = new Set<string>();

  for (const member of slateMembers) {
    const key = member.email.toLowerCase();
    seen.add(key);
    const { verdict, reason } = classifyRosterMember(member, hosts.has(key));
    rows.push({ email: member.email, verdict, reason });
  }
  // A host with no Slate row is carried through rather than dropped: iterating
  // only Slate's side is exactly how somebody cal.com is routing to can be
  // invisible, which is half of what this exists to find.
  for (const host of hosts) {
    if (seen.has(host)) continue;
    const { verdict, reason } = classifyRosterMember(null, true);
    rows.push({ email: host, verdict, reason });
  }

  return { rows, hostsEmpty: hosts.size === 0 };
}

/**
 * The sweep's own verdict: the worst row.
 *
 * An EMPTY sweep answers null rather than "agree", because judging nothing is
 * never a pass (L98). A sweep whose worst row ranks level with agreement answers
 * "agree", so the nine expected staff accounts cannot name a run just by being
 * listed first.
 */
export function worstRosterVerdict(verdicts: RosterVerdict[]): RosterVerdict | null {
  if (verdicts.length === 0) return null;
  let worst: RosterVerdict = "agree";
  for (const v of verdicts) {
    if (ROSTER_VERDICT_RANK[v] > ROSTER_VERDICT_RANK[worst]) worst = v;
  }
  return worst;
}
