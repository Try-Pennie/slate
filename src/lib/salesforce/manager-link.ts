/**
 * Resolving a rep's manager of record from the `Agent_Manager__c` picklist NAME
 * (#1653). Pure, so every branch is reachable from a test with no Salesforce and
 * no database.
 *
 * ## What was wrong
 *
 * The sync built its name to email map with `if (nm && em && !nameToEmail.has(nm))`,
 * which keeps the FIRST Salesforce user answering to a picklist name and throws the
 * rest away with no record. That is L521: a lookup that requires exactly one match
 * must treat many as its own refusal, never as an answer.
 *
 * It is not cosmetic, because `manager_id` decides who APPROVES that person's time
 * off and who may see their requests. Picking one of two routes an approval to
 * somebody who may not be their manager, and every surface downstream reads as
 * healthy: the sync reports a successful run, the OOO screens show a manager, and
 * the request lands in a real person's Slack.
 *
 * Measured against the live org on 2026-08-31: four names are shared by more than
 * one Salesforce user carrying an email, which is exactly the set the sync's
 * manager query scans, and one of those pairs is shared by two ACTIVE users.
 *
 * ## The rules, and why each one is the way it is
 *
 * **Exactly one match links.** Anything else refuses and is reported.
 *
 * **Many and none are different outcomes** (L11). They need opposite things done
 * about them: a shared name is somebody editing Salesforce so the name is unique,
 * an unmatched name is somebody correcting a picklist value or provisioning a
 * person who is missing. Reporting them as one number would tell a reader neither.
 *
 * **An ambiguous name is never handed to the looser fallback matcher** (L75). The
 * fallback exists for informal picklist values ("Mike Dugan" against the user
 * "Michael Dugan"), and it matches on less evidence than the exact pass does. A
 * refusal retried by a looser matcher is aiming at a nearby candidate, which is
 * the failure the refusal exists to prevent. Only names the exact pass matched
 * NOTHING at all get a second look.
 *
 * **Matches are deduplicated to distinct PEOPLE before being counted.** The
 * candidate pool is assembled from more than one query and `queryAll` paginates,
 * so a record arriving twice must not read as two people sharing a name: that
 * would refuse every ordinary manager in the org. Identity is `User.Id` where the
 * query asked for it, and the name plus email where it did not.
 *
 * **This resolves a NAME, and it deliberately still does.** `users.salesforce_user_id`
 * (#1587) is a better key than an email for naming a rep across a system boundary,
 * but it cannot remove the ambiguity this module exists for: `Agent_Manager__c`
 * holds a name, so any id has to be looked up FROM that name first, and the
 * collision lives in that lookup either way. See the PR for #1653 for the two
 * measurements behind that decision.
 */

/** One Salesforce user that could answer to a picklist name. */
export interface SfManagerCandidate {
  /** Full `User.Name` as Salesforce returns it. */
  name: string;
  firstName: string;
  lastName: string;
  /** The email the manager link is written against. A candidate without one is not a match. */
  email: string;
  /**
   * `User.Id`, when the query that produced this record asked for it.
   *
   * Deliberately NOT called `salesforceUserId`, which is the name of the STORED
   * Slate column (#1587). This is an id read straight off a Salesforce response
   * and used only as a dedup key; it is never read from a Slate row and never
   * written to one, so borrowing the column's name would invite a later reader to
   * treat it as the governed key and hand-roll their own idea of what a missing
   * one means. `scripts/test-salesforce-user-id-contract.ts` says the same thing
   * by failing the build on that spelling here.
   */
  salesforceRecordId: string | null;
}

/** A picklist name more than one Salesforce user answers to, so nothing is linked. */
export interface ManagerNameAmbiguity {
  name: string;
  matchCount: number;
}

export interface ManagerNamePlan {
  /** Picklist name (exactly as given) to manager email, only where ONE person matched. */
  resolved: Map<string, string>;
  /** Names refused because several people matched (L521). */
  ambiguous: ManagerNameAmbiguity[];
  /** Names refused because nobody matched. A different thing to go and do (L11). */
  unmatched: string[];
}

/** Whether one Salesforce user answers to one picklist name. */
export type ManagerNameMatcher = (
  name: string,
  candidate: SfManagerCandidate,
) => boolean;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/** The strict pass: the picklist value IS the user's Salesforce name. */
export const exactNameMatch: ManagerNameMatcher = (name, candidate) =>
  !!norm(name) && norm(name) === norm(candidate.name);

/**
 * The loose pass, for informal picklist values: same last name, same first
 * initial. Deliberately weaker than the exact pass, which is why it only ever
 * sees names the exact pass matched nothing at all for.
 */
export const initialLastNameMatch: ManagerNameMatcher = (name, candidate) => {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const initial = tokens[0][0]?.toLowerCase();
  const last = norm(tokens[tokens.length - 1]);
  const candidateFirst = candidate.firstName.trim()[0]?.toLowerCase();
  const candidateLast = norm(candidate.lastName);
  if (!initial || !last || !candidateFirst || !candidateLast) return false;
  return initial === candidateFirst && last === candidateLast;
};

/**
 * The identity of the PERSON behind a candidate record, so the same record
 * arriving from two queries is counted once and two real people are counted
 * twice. `User.Id` where the query asked for it; the name plus email otherwise,
 * which is the most the record carries.
 */
function personKey(candidate: SfManagerCandidate): string {
  const id = candidate.salesforceRecordId?.trim();
  return id ? `id:${id}` : `ne:${norm(candidate.name)}|${norm(candidate.email)}`;
}

/**
 * Decides, for each picklist name, whether it names exactly one Salesforce user
 * and what to report instead when it does not.
 *
 * A candidate with no email is not a match at all: the manager link is written
 * against an email, so such a record could never be the answer, and letting it
 * count would manufacture ambiguity out of a record nobody could have used.
 */
export function planManagerNames(
  names: string[],
  candidates: SfManagerCandidate[],
  match: ManagerNameMatcher,
): ManagerNamePlan {
  const usable = candidates.filter((c) => norm(c.email));
  const plan: ManagerNamePlan = {
    resolved: new Map<string, string>(),
    ambiguous: [],
    unmatched: [],
  };

  for (const name of names) {
    if (plan.resolved.has(name)) continue;
    if (plan.ambiguous.some((a) => a.name === name)) continue;
    if (plan.unmatched.includes(name)) continue;

    const people = new Map<string, string>();
    for (const c of usable) {
      if (match(name, c)) people.set(personKey(c), norm(c.email));
    }

    if (people.size === 1) {
      plan.resolved.set(name, [...people.values()][0]);
    } else if (people.size > 1) {
      plan.ambiguous.push({ name, matchCount: people.size });
    } else {
      plan.unmatched.push(name);
    }
  }

  return plan;
}

/**
 * Folds a second, looser pass over the first pass's UNMATCHED names into one plan.
 *
 * The second pass's verdict wins only for names the first pass left unmatched,
 * which is the only set it was ever given. Written as a derivation from `first`
 * rather than as "take the second plan's unmatched list", so it stays correct if a
 * caller ever hands it a second pass computed over a different set: an ambiguous
 * name cannot be resurrected as a link by anything the second pass says.
 */
export function mergeManagerNamePlans(
  first: ManagerNamePlan,
  second: ManagerNamePlan,
): ManagerNamePlan {
  const resolved = new Map(first.resolved);
  const ambiguous = [...first.ambiguous];
  const unmatched: string[] = [];

  for (const name of first.unmatched) {
    const secondResolved = second.resolved.get(name);
    if (secondResolved) {
      resolved.set(name, secondResolved);
      continue;
    }
    const secondAmbiguous = second.ambiguous.find((a) => a.name === name);
    if (secondAmbiguous) {
      ambiguous.push(secondAmbiguous);
      continue;
    }
    unmatched.push(name);
  }

  return { resolved, ambiguous, unmatched };
}

/**
 * Splits the per-AGENT unresolved report from `resolveManagerSync` into the two
 * refusals, so each can be said in its own words.
 *
 * `resolveManagerSync` sees only "Salesforce named a manager and we have no email
 * for them", which is the same value for both refusals. Without this split the
 * sync would report one number covering a config gap somebody can fix in a minute
 * and a routing ambiguity that may be pointing an approval at the wrong person.
 */
export function splitUnresolvedByAmbiguity(
  unresolvedNames: string[],
  ambiguousNames: string[],
): { ambiguous: string[]; missing: string[] } {
  const shared = new Set(ambiguousNames);
  const ambiguous: string[] = [];
  const missing: string[] = [];
  for (const name of unresolvedNames) {
    if (shared.has(name)) ambiguous.push(name);
    else missing.push(name);
  }
  return { ambiguous, missing };
}
