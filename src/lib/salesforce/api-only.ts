/**
 * API only Salesforce accounts are never a person, so they never answer for one
 * (#3669). Pure.
 *
 * The roster sync matches a Slate user to a Salesforce user by EMAIL, in every
 * query that feeds it: the roster itself, both manager name passes, the by-email
 * backfill of the cross system key, and the presence read the reap and the
 * reconcile share. Salesforce needs a deliverable address on an integration
 * account, so those are routinely created carrying a real colleague's email. On
 * 2026-10-13 one ("integration launchpad", profile "Salesforce API Only System
 * Integrations") made a staff address answer to two active users, and the next
 * hourly run paged an ambiguous conflict about a person with nothing wrong. It
 * recurs whenever one is set up, and the account's email is not going to change
 * (Dan, 2026-10-13), so this is the fix rather than a cleanup in Salesforce.
 *
 * ## Why the profile's API only permission, and not a name or a type
 *
 * Read against the live org on 2026-10-13 (aggregates only, no addresses):
 *
 * - `Profile.PermissionsApiUserOnly` is TRUE on every integration profile the org
 *   has (the five on the Salesforce Integration licence, the two Analytics Cloud
 *   ones, Sales Insights, CPQ) and FALSE on every profile a person logs in with
 *   (Sales, Sales Manager, System Administrator, Standard User, Chatter Free,
 *   Identity). Excluding it, no active address is shared by two users at all;
 *   including it, three are.
 * - `User.UserType` reads `Standard` on every active user, integrations included,
 *   so it cannot tell them apart.
 * - A list of profile NAMES would be the org's own list frozen on the day it was
 *   written, and the next integration profile somebody creates would be exempt.
 *   The permission is what makes an account API only, whatever its profile is
 *   called.
 *
 * What it cannot see: API only granted through a PERMISSION SET rather than the
 * profile. No account in the org is set up that way today; one that is would still
 * be matched, which raises the conflict page rather than dropping anybody.
 *
 * ## Which way an unreadable flag falls
 *
 * Anything the response did not say (no `Profile`, a null flag) is read as a
 * PERSON. A person wrongly kept raises the conflict page, which is loud; a person
 * wrongly dropped vanishes from the roster's matching in silence. That is also why
 * every query must SELECT the flag (`requireApiOnlyField`): a query that forgot it
 * would hand back records that all read as people, and the exclusion would stop
 * applying with nothing to say so.
 */

/** The SOQL path of the flag, selected by every User query that feeds the roster. */
export const API_ONLY_PROFILE_FIELD = "Profile.PermissionsApiUserOnly";

/** The part of a Salesforce User record this module reads. */
export interface ApiOnlyReadable {
  Profile?: { PermissionsApiUserOnly?: boolean | null } | null;
}

/** True only for a record whose profile positively says it is API only. */
export function isApiOnlyAccount(record: ApiOnlyReadable): boolean {
  return record.Profile?.PermissionsApiUserOnly === true;
}

/**
 * Split a Salesforce response into the people and the integration accounts.
 *
 * The integration accounts are returned rather than discarded so the caller can
 * COUNT them: a real person mis-profiled as an integration must be visible in the
 * run's log, not silently absent from it.
 */
export function partitionApiOnly<T extends ApiOnlyReadable>(
  rows: T[],
): { people: T[]; apiOnly: T[] } {
  const people: T[] = [];
  const apiOnly: T[] = [];
  for (const row of rows) (isApiOnlyAccount(row) ? apiOnly : people).push(row);
  return { people, apiOnly };
}

/**
 * Refuse a User query that does not SELECT the flag.
 *
 * Checked on the SELECT list only: naming the field in a WHERE clause filters on
 * it but returns records without it, which would read as people.
 */
export function requireApiOnlyField(soql: string): void {
  const upper = soql.toUpperCase();
  const from = upper.indexOf(" FROM ");
  const selectList = from >= 0 ? soql.slice(0, from) : soql;
  if (!selectList.includes(API_ONLY_PROFILE_FIELD)) {
    throw new Error(
      `A Salesforce User query feeding the roster must select ${API_ONLY_PROFILE_FIELD}, ` +
        `or every record it returns reads as a person and API only integration ` +
        `accounts match staff emails again (#3669).`,
    );
  }
}
