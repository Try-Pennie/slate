/**
 * The shared cross system rep key: Salesforce `User.Id` on a Slate user (#1587).
 *
 * Slate identifies a rep by EMAIL, and resolves their manager by matching the
 * `Agent_Manager__c` picklist NAME. Both are values a person can change, and
 * neither carries any promise of stability, so anything that has to name a rep
 * across a system boundary (#307's time off feed to PET, #329's manager drift
 * check) is betting on a string that can be edited out from under it. A rename in
 * Salesforce would not fail: it would silently start naming somebody else, or
 * nobody, and the sync would report a healthy run throughout.
 *
 * `users.salesforce_user_id` is the fix, and this module is the whole decision:
 * pure, so every branch is reachable from a test without a database or Salesforce.
 *
 * ## The rules, and why each one is the way it is
 *
 * **Never overwritten.** A stored id that Salesforce now disagrees with is
 * REPORTED, not rewritten. Rewriting would re-point every consumer at a different
 * human, and would look exactly like a healthy sync doing its job. The two ways a
 * disagreement arises (a Salesforce User recreated for the same person, or an email
 * reassigned to a different person) need opposite corrections, and nothing here can
 * tell them apart, so a person decides.
 *
 * **Never cleared.** A roster row absent from a Salesforce response is not
 * evidence its Salesforce user is gone: this sync queries a slice of the org.
 * Clearing on absence would drop the key every time a query narrowed.
 *
 * **Many matches store NO id** (L521). A lookup that requires exactly one match
 * must treat many as its own refusal, never as absence. Storing the first of two
 * is a coin flip nobody would know had been tossed. This is not hypothetical:
 * measured against the live org on 2026-08-31, two email addresses are shared by
 * more than one ACTIVE Salesforce User.
 *
 * **An id another Slate row already holds is refused.** The partial unique index
 * behind this column would refuse the write anyway, and a refused write throws the
 * whole hourly roster sync. Deciding it here turns a roster outage into a report
 * about the one row that is wrong.
 */

/** One Slate roster row, as the planner needs to see it. */
export interface SlateRosterRow {
  id: string;
  email: string;
  salesforceUserId: string | null;
}

/** One (email, Salesforce User.Id) pair observed in a Salesforce response. */
export interface SfIdCandidate {
  email: string;
  salesforceUserId: string;
}

export interface UserIdAssignment {
  userId: string;
  email: string;
  salesforceUserId: string;
}

/** Slate holds one id and Salesforce now names a different one. Reported, never written. */
export interface UserIdDisagreement {
  userId: string;
  email: string;
  stored: string;
  salesforce: string;
}

/** More than one Salesforce User matched the key, so no id is stored (L521). */
export interface UserIdAmbiguity {
  email: string;
  matchCount: number;
}

/** The resolved id is already held by another Slate row, so no id is stored. */
export interface UserIdClaimed {
  userId: string;
  email: string;
  salesforceUserId: string;
  heldBy: string;
}

/** A roster row with no id that Salesforce could not resolve at all. */
export interface UserIdUnresolved {
  userId: string;
  email: string;
}

export interface UserIdLinkPlan {
  assign: UserIdAssignment[];
  disagreements: UserIdDisagreement[];
  ambiguous: UserIdAmbiguity[];
  claimed: UserIdClaimed[];
  unresolved: UserIdUnresolved[];
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Decides, for each Slate roster row, whether to write a Salesforce User Id and
 * what to report instead when it must not.
 *
 * `candidates` may legitimately contain the same record twice (it is assembled from
 * several Salesforce queries that overlap), so matches are deduplicated by id
 * BEFORE the one-match test. Deduplicating is what tells a repeated response apart
 * from two real people sharing an address, and conflating the two would either
 * refuse every ordinary row or accept every ambiguous one.
 */
export function planSalesforceUserIds(
  roster: SlateRosterRow[],
  candidates: SfIdCandidate[],
): UserIdLinkPlan {
  // email -> the distinct Salesforce ids seen for it.
  const idsByEmail = new Map<string, Set<string>>();
  for (const c of candidates) {
    const email = (c.email ?? "").trim().toLowerCase();
    const id = normalizeId(c.salesforceUserId);
    if (!email || !id) continue;
    const set = idsByEmail.get(email) ?? new Set<string>();
    set.add(id);
    idsByEmail.set(email, set);
  }

  // Every id ALREADY held in Slate, and by whom, so a write that the partial
  // unique index would refuse is decided here instead of thrown there.
  const heldBy = new Map<string, string>();
  for (const r of roster) {
    const id = normalizeId(r.salesforceUserId);
    if (id && !heldBy.has(id)) heldBy.set(id, r.id);
  }

  const plan: UserIdLinkPlan = {
    assign: [],
    disagreements: [],
    ambiguous: [],
    claimed: [],
    unresolved: [],
  };
  // One entry per ambiguous email, not one per row that hit it.
  const reportedAmbiguous = new Set<string>();
  // Ids this very plan is about to hand out, so two rows in one pass cannot both
  // be assigned the same id and collide inside a single batch.
  const assignedThisPass = new Map<string, string>();

  for (const r of roster) {
    const email = (r.email ?? "").trim().toLowerCase();
    const stored = normalizeId(r.salesforceUserId);
    const matches = email ? [...(idsByEmail.get(email) ?? [])] : [];

    if (matches.length > 1) {
      // Many matches is a refusal in its own right. It is reported as ambiguity
      // whether or not the row already holds an id, and it is deliberately NOT
      // reported as a disagreement even when the stored id is one of the matches:
      // nothing here can say which of them is right.
      if (!reportedAmbiguous.has(email)) {
        reportedAmbiguous.add(email);
        plan.ambiguous.push({ email, matchCount: matches.length });
      }
      continue;
    }

    if (matches.length === 0) {
      // Absence is only worth reporting for a row that has no key yet. A row that
      // already holds one keeps it: this sync queries a slice of the org, so being
      // absent from one response says nothing about the Salesforce user existing.
      if (!stored) plan.unresolved.push({ userId: r.id, email });
      continue;
    }

    const resolved = matches[0];
    if (stored) {
      if (stored !== resolved) {
        plan.disagreements.push({
          userId: r.id,
          email,
          stored,
          salesforce: resolved,
        });
      }
      // stored === resolved: already correct, so a quiet hour writes nothing.
      continue;
    }

    const holder = heldBy.get(resolved) ?? assignedThisPass.get(resolved);
    if (holder && holder !== r.id) {
      plan.claimed.push({
        userId: r.id,
        email,
        salesforceUserId: resolved,
        heldBy: holder,
      });
      continue;
    }

    assignedThisPass.set(resolved, r.id);
    plan.assign.push({ userId: r.id, email, salesforceUserId: resolved });
  }

  return plan;
}

/** The counts a caller reports, plus whether anything needs a person to look. */
export interface UserIdLinkReport {
  linked: number;
  disagreements: number;
  ambiguous: number;
  claimed: number;
  unresolved: number;
}

/**
 * Whether a plan holds anything a person has to act on.
 *
 * `unresolved` is deliberately NOT in here. A row with no key is a row every
 * consumer correctly refuses, which is safe; a row with a key that may name the
 * WRONG human is not. Wrong is worse than missing, so the three conflict shapes
 * page and absence is reported in the run's counts and its log line.
 */
export function hasUserIdConflicts(report: UserIdLinkReport): boolean {
  return report.disagreements > 0 || report.ambiguous > 0 || report.claimed > 0;
}

/**
 * The ONLY way a consumer may read a rep's Salesforce User Id (L75).
 *
 * Throws when there is no id. There is no email fallback and no name fallback,
 * deliberately and permanently: a fallback would hand back exactly the property
 * this column exists to remove, and it would do so silently, on the rows most
 * likely to be misconfigured. An outward action that cannot name its target
 * refuses; it does not aim at a nearby candidate.
 *
 * The refusal names the row's id so a reader can go and look at it, and does NOT
 * echo the email, so the message can never be mistaken for a usable value.
 *
 * `scripts/test-salesforce-user-id-contract.ts` enforces that every consumer of
 * the column comes through here.
 */
export function requireSalesforceUserId(user: {
  id: string;
  salesforce_user_id: string | null;
}): string {
  const id = normalizeId(user.salesforce_user_id);
  if (!id) {
    throw new Error(
      `No Salesforce User Id stored for Slate user ${user.id}. Refusing rather than ` +
        `matching on a name or an email, which is the substitution this key exists to ` +
        `remove. The hourly roster sync fills it in; check its unresolved count.`,
    );
  }
  return id;
}
