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

/**
 * What cal.com can do with somebody, which is NOT the same as whether it lists them.
 *
 * The event type's `hosts[]` says who CAN take a booking. Six of cal.com's seven
 * routing forms then carry a `Redistribute Team (does not equal) yes` clause on
 * every route, so the pool it actually ROUTES to is narrower than the list. Reading
 * the list alone was wrong in both directions on 2026-09-08: two agents Slate
 * correctly held back were paged on daily as divergent, while twelve agents Slate
 * offers and cal.com never routes to were reported as agreement (#2088).
 */
export type CalcomStanding =
  /** Not on the event type's host list at all. */
  | "not-a-host"
  /** A host, and nothing withholds them, so a lead can reach them. */
  | "routable"
  /** A host cal.com withholds from every routed decision (a `WithheldSet` member). */
  | "excluded";

/** A Slate user as this comparison needs them. */
export interface SlateRosterMember {
  email: string;
  role: string;
  bookable: boolean;
  /** Offboarding marker: set means they have left. */
  deactivatedAt: string | null;
  isTest: boolean;
  /**
   * Whether ANY real bucket could actually match them.
   *
   * This used to be "carries any Salesforce attribute at all", which is a proxy for
   * the question rather than the question (L63), and the reason string below has
   * always claimed the stronger thing. `rsegui@` carried `{"role":"Sales"}` and
   * nothing else; every one of the 60 buckets keys on `debt_team`, some also on
   * `backend_service`, and none keys on `role`, so no bucket
   * could ever reach them. They were paged on daily as held back (#2094).
   *
   * Computed by the caller through the SHIPPED pool predicate over the live bucket
   * criteria (`matchableAgentIds`), never by a rule written beside it, so it cannot
   * disagree with what routing does.
   */
  matchableByAnyBucket: boolean;
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
  /** A cal.com host account that is deliberately not a Slate user, named in
   *  `KNOWN_NON_SLATE_HOSTS` with its reason. Expected, and can never fail a run. */
  | "known-not-in-slate"
  /** Slate offers somebody cal.com does not list as a host at all. */
  | "bookable-not-hosting"
  /** Slate offers somebody cal.com lists and deliberately withholds from routing. */
  | "bookable-not-routable"
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
 * `known-not-in-slate` sits there too, for the same reason and with the same
 * consequence: it is an address nobody is ever going to add to Slate, so a rank of
 * its own would keep a page standing for as long as the account exists.
 *
 * Departure outranks everything, including role, because it is the only state
 * that puts a real lead in front of somebody who has gone.
 */
export const ROSTER_VERDICT_RANK: Record<RosterVerdict, number> = {
  agree: 0,
  "staff-not-bookable": 0,
  "known-not-in-slate": 0,
  "not-bookable-by-design": 1,
  "absent-from-slate": 2,
  "bookable-not-hosting": 3,
  // Above "not a host at all", because it is the stronger statement: cal.com holds
  // this person and deliberately withholds them, so Slate offering them is a
  // decision the incumbent has explicitly made the other way.
  "bookable-not-routable": 4,
  "held-back-still-hosting": 5,
  "departed-still-hosting": 6,
};

/**
 * cal.com host addresses that are deliberately NOT Slate users, each with why.
 *
 * `absent-from-slate` pages, and it has to: a host missing from Slate is routinely
 * a new hire nobody added, and at cutover they take no leads while looking fine on
 * every screen. So the exemption is BY NAME here rather than by softening that
 * verdict, which would blind the check to the case it exists for.
 *
 * The condition being exempted is "an account that hosts in cal.com and is
 * deliberately not a Slate user", written as that reason rather than as a bare
 * list, because an exemption recorded as one named case stops covering the moment
 * a second case satisfies the same reason (L362). It cannot be derived from data:
 * cal.com will not say what an account is for, and per-user attribute values
 * answer 404 (measured 2026-09-07), so somebody has to say so once, here.
 *
 * Keys are lowercased, since that is how both sides' addresses are matched.
 *
 * It is SELF LIMITING by construction: only `compareRosters`' host loop, which
 * runs for addresses with no Slate row at all, ever consults it. The day one of
 * these becomes a real Slate user it is judged on its merits, so a stale entry
 * cannot hide a genuine finding. `scripts/test-roster-parity.ts` pins that, and
 * carries the positive control that an UNLISTED absent host still pages.
 */
export const KNOWN_NON_SLATE_HOSTS: Readonly<Record<string, string>> = {
  "hariom-cal@trypennie.com":
    "a cal.com host account that is deliberately not a Slate user (Dan, 2026-09-08), so there is nothing to reconcile and nothing anybody should do about it",
};

/**
 * The addresses cal.com WITHHOLDS from every routed decision.
 *
 * `Redistribute Team = YES` in cal.com. Six of the seven live routing forms carry
 * `Redistribute Team (does not equal) yes` on every route, so a member marked YES
 * cannot be reached by any of them while still appearing on the event type's host
 * list. Guided App Completion carries the clause on none of its 26 routes, which is
 * an open question on #2033 and deliberately parked: BC confirmed on 2026-09-08
 * that the seven forms were split for tracking rather than for routing.
 *
 * IT IS A PARAMETER, AND IT COMES FROM TWILIO (#2153). It used to be a constant in
 * this file, sixteen addresses read out of the cal.com UI by hand on 2026-09-08,
 * because cal.com will not report per-user attribute values
 * (`/organizations/{org}/users/{id}/attributes` answers 404 on both API versions)
 * and the routing forms give the CONDITION without saying who satisfies it. Nothing
 * maintained it, and one day later the command was already reporting that two of
 * the sixteen were no longer hosts.
 *
 * Measured on 2026-09-10, the hand list was wrong in both directions: Twilio tagged
 * 22 people, 8 of whom the list had never heard of, while 2 of its entries carried
 * no tag at all. Twilio is where a manager actually sets this, and the Pipedream job
 * that reads those tags is what puts `Redistribute Team = YES` on the cal.com member
 * in the first place, so reading the tags reads the source of the very value this
 * needs rather than a person's snapshot of its effect.
 *
 * NOT `users.attributes.redistribute`, which #2153 proposed and which is a different
 * fact. That key is Slate's record of whom IT took out of the bookable pool because
 * of the tag, so an agent who was already not bookable when the tag appeared is
 * never marked: measured the same day, it covered 13 of the 22 tagged people. Using
 * it would have reported the other 9 as routable and put this check back in exactly
 * the false agreement #2088 fixed.
 *
 * Addresses lowercased, since that is how both sides are matched.
 */
export type WithheldSet = ReadonlySet<string>;

/** One Twilio worker, as far as building the withheld set is concerned. */
export interface WithheldWorkerRead {
  ok: boolean;
  side?: { email: string; redistribute: boolean };
}

/**
 * The addresses to withhold, from what Twilio answered.
 *
 * A worker that could not be READ contributes nothing and is not an error here:
 * `readWorker` refuses a corrupt attributes blob and a worker with no email, both of
 * which are ordinary in that workspace (queue entities, vendor automations). What is
 * NOT ordinary is the whole read failing, and that is the caller's refusal, because
 * an empty set and a failed read are the same value and only the caller can tell
 * them apart (L98).
 */
export function withheldFromWorkers(reads: readonly WithheldWorkerRead[]): Set<string> {
  const out = new Set<string>();
  for (const read of reads) {
    if (!read.ok || !read.side?.redistribute) continue;
    const email = read.side.email.trim().toLowerCase();
    if (email !== "") out.add(email);
  }
  return out;
}

/** Whether this environment can answer who cal.com withholds (#2153). */
export type WithheldReadiness =
  | { ok: true }
  | { ok: false; missing: string[] };

/**
 * The three Twilio variables the withheld set needs, checked together.
 *
 * Its own refusal rather than folded into the cal.com key's, because they are two
 * different things to go and fix (L11), and it NAMES the ones that are missing
 * rather than saying Twilio is not configured, so somebody who set two of three is
 * told which one they missed.
 */
export function withheldReadiness(env: Record<string, string | undefined>): WithheldReadiness {
  const missing = ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_WORKSPACE_SID"].filter(
    (name) => (env[name] ?? "").trim() === "",
  );
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

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
 *
 * `absentEmail` is the address being judged when there is no Slate row, and it is
 * REQUIRED rather than defaulted, because the only thing it does is let the
 * exemption above apply: a caller that forgot it would silently get a page that
 * stands forever, which is the defect this parameter exists to prevent (L168). It
 * is ignored when `slate` is given, since the address is on the row itself and two
 * sources for one value can only disagree (L70). Pass null where there is nothing
 * to say.
 */
export function classifyRosterMember(
  slate: SlateRosterMember | null,
  standing: CalcomStanding,
  absentEmail: string | null,
): { verdict: RosterVerdict; reason: string } {
  if (slate === null) {
    if (standing === "not-a-host") return { verdict: "agree", reason: "" };
    // `excluded` is deliberately NOT separated here. Nobody is in that state today,
    // and what this branch reports is Slate's roster being incomplete rather than a
    // routing risk, so a verdict of its own would be a category nothing writes to
    // (L90). It is one line to split if somebody ever lands in it.
    const known = absentEmail === null ? undefined : KNOWN_NON_SLATE_HOSTS[absentEmail.toLowerCase()];
    if (known !== undefined) return { verdict: "known-not-in-slate", reason: known };
    return {
      verdict: "absent-from-slate",
      reason: "hosts in cal.com and has no Slate record at all, so neither system can reconcile them",
    };
  }

  // Departure stays loud whether or not cal.com withholds them from routing, and
  // that is deliberate. The stand down for `excluded` rests on one reason, that no
  // routed decision can reach them, and a departed person carries a second harm the
  // exclusion says nothing about: they are still in the incumbent's configuration,
  // so a direct link reaches them, and the catch all route every form carries has an
  // EMPTY condition, so the redistribute clause does not apply to it (#1908 measured
  // that path carrying about 2% of bookings). A stand down must be no broader than
  // its reason (L324).
  if (slate.deactivatedAt !== null) {
    return standing !== "not-a-host"
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
    if (standing === "routable") return { verdict: "agree", reason: "" };
    if (standing === "excluded") {
      return {
        verdict: "bookable-not-routable",
        reason:
          "bookable in Slate while cal.com withholds them from every routed decision, " +
          "so Slate offers a lead somebody the incumbent has decided not to route to",
      };
    }
    return {
      verdict: "bookable-not-hosting",
      reason: "bookable in Slate and not a host in cal.com at all, so Slate offers somebody the incumbent never routes to",
    };
  }

  if (standing === "not-a-host") return { verdict: "agree", reason: "" };
  // BOTH systems withhold them, which is agreement however loudly the host list
  // implies otherwise. This is what kept the page lit over `cfrank@` and `rsegui@`
  // for as long as the check read the list instead of the routing (#2088).
  //
  // The scope of that claim, stated so nobody reads more into it: this comparison
  // is about ONE event type and the routing forms that feed it, every one of which
  // carries the redistribute clause on every route. It says nothing about the catch
  // all route, which has an empty condition and lands on a different event type
  // (#1908), so "agreement" here means no ROUTED lead reaches them rather than that
  // cal.com could never produce one by another path.
  if (standing === "excluded") return { verdict: "agree", reason: "" };

  if (STAFF_ROLES.has(slate.role)) {
    return {
      verdict: "staff-not-bookable",
      reason: `${article(slate.role)} ${slate.role.replace(/_/g, " ")} who hosts in cal.com and is deliberately not bookable in Slate`,
    };
  }
  if (!slate.matchableByAnyBucket) {
    return {
      verdict: "not-bookable-by-design",
      reason: "not bookable in Slate and hosts in cal.com, but no bucket's criteria can match their attributes, so no lead could reach them here anyway",
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
   * How many withheld addresses cal.com no longer lists as hosts.
   *
   * A drift signal rather than a finding, and since #2153 it measures Twilio
   * against cal.com rather than a hand list against cal.com.
   */
  withheldNoLongerHosting: number;
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
  withheld: WithheldSet,
): RosterComparison {
  const hosts = new Set([...calcomHostEmails].map((e) => e.toLowerCase()));
  const rows: RosterRow[] = [];
  const seen = new Set<string>();

  for (const member of slateMembers) {
    const key = member.email.toLowerCase();
    seen.add(key);
    const { verdict, reason } = classifyRosterMember(member, standingOf(key, hosts, withheld), null);
    rows.push({ email: member.email, verdict, reason });
  }
  // A host with no Slate row is carried through rather than dropped: iterating
  // only Slate's side is exactly how somebody cal.com is routing to can be
  // invisible, which is half of what this exists to find.
  for (const host of hosts) {
    if (seen.has(host)) continue;
    const { verdict, reason } = classifyRosterMember(null, standingOf(host, hosts, withheld), host);
    rows.push({ email: host, verdict, reason });
  }

  return {
    rows,
    hostsEmpty: hosts.size === 0,
    // Withheld addresses that are no longer hosts. Not a finding: it is the signal
    // that Twilio and cal.com have drifted apart, which is now what it measures.
    // Somebody carrying the tag whom cal.com does not list as a host means the
    // Pipedream job has not carried the tag across, or they have left the event
    // type; either way the two systems disagree about somebody and the run says the
    // number rather than pretending they agree.
    withheldNoLongerHosting: [...withheld].filter((e) => !hosts.has(e)).length,
  };
}

/**
 * What cal.com can do with one address.
 *
 * Being withheld only means anything for somebody cal.com actually HOLDS: an
 * address on the list who is not a host is simply not a host, and saying otherwise
 * would report a routing decision about a person cal.com cannot route to at all.
 */
function standingOf(emailKey: string, hosts: Set<string>, withheld: WithheldSet): CalcomStanding {
  if (!hosts.has(emailKey)) return "not-a-host";
  return withheld.has(emailKey) ? "excluded" : "routable";
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
