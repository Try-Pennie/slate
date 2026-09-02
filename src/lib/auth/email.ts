/**
 * The one way an address becomes a `users.email` value (#1663).
 *
 * `users.email` is unique but CASE SENSITIVE, and Google addresses are
 * effectively case insensitive, so without this the same person can arrive under
 * two spellings: a row synced from Salesforce as `Agent@trypennie.com` and a
 * login arriving as `agent@trypennie.com` miss each other's by-email read AND
 * both satisfy `users_email_key`, because the two strings genuinely differ. One
 * person, two identities, and the roster, the bookable pool, the manager link and
 * every per agent count can each resolve to a different half. The halves do not
 * converge on their own.
 *
 * **Slate stores the normalised form**, rather than storing whatever case arrived
 * and comparing on `lower(email)`. Storing loses the display casing, which is not
 * worth having on a work address (the display name lives in `users.name`), and it
 * buys the thing that matters: every reader that already does `.eq("email", x)`
 * stays correct without having to remember a rule. Comparing instead would make
 * each of the dozens of readers individually responsible for it, and the one that
 * forgets fails silently by finding nothing (L30: fix the class).
 *
 * `users_email_lower_idx` (migration 0112) is the backstop, not the mechanism. A
 * writer that skipped this helper would be REFUSED by the index rather than
 * silently creating the duplicate, which is a hard failure at login rather than a
 * split identity nobody notices. `scripts/test-email-normalization.ts` keeps every
 * writer on the helper so that backstop stays a backstop.
 *
 * Deliberately only case and surrounding whitespace. Google also ignores dots and
 * a plus tag in a gmail.com local part, and `emailLocalKey` in `pending-access.ts`
 * strips those, but that is a SUGGESTION engine looking for a likely typo. Folding
 * them here would merge two addresses a Workspace admin can genuinely issue to two
 * different people, which is the worse direction to be wrong in.
 */
export const normalizeEmail = (raw: string): string => (raw ?? "").trim().toLowerCase();
