/**
 * A scheduling coordinator's Microsoft sign in (#4379).
 *
 * The call center partner's coordinators sign in with their own company Microsoft
 * account, through Supabase Auth's `azure` provider, and nobody else does: staff stay
 * Google only. Three places hold the rule, each blind where the others look:
 *
 *  - the before_user_created hook (migration 0212) creates an auth user through azure
 *    only for an address an active, unlinked coordinator row holds;
 *  - the sign in callback links that auth user to the row (`linkCoordinator` in
 *    `src/lib/provision.ts`), recording the Microsoft account's permanent id;
 *  - `realCurrentUser` judges every request: a coordinator on an outside address needs
 *    the Microsoft account on record and no Google account (`judgeSessionIdentity`).
 *
 * The account id is the `sub` GoTrue keeps on the auth user's azure identity, which
 * the session holder cannot write. The address only finds the row, exactly as for
 * Google (`google-identity.ts`), and the same judge decides (`account-identity.ts`).
 */
import { accountIdsOf, type AuthUserIdentities } from "./account-identity.ts";

/** Supabase Auth's name for the Microsoft (Entra ID) provider. */
export const MICROSOFT_PROVIDER = "azure";

/** Every Microsoft account id on an auth user, read from its identities. */
export function microsoftAccountIdsOf(user: AuthUserIdentities): string[] {
  return accountIdsOf(user, MICROSOFT_PROVIDER);
}

/**
 * A Microsoft sign in on an address no active coordinator holds (#4379): never
 * invited, removed since, or a row that is not a coordinator's. Settled rather than
 * retryable (L111): only a super admin granting the address changes the answer.
 */
export class CoordinatorNotInvitedError extends Error {
  constructor(message = "no active coordinator holds this address, so it has no Slate account") {
    super(message);
    this.name = "CoordinatorNotInvitedError";
  }
}

/**
 * A Microsoft sign in refused because its account is not the one this coordinator's
 * Slate account belongs to, or the row already belongs to another sign in (#4379).
 * Settled: signing in again with the same account can never work. Carries the row's
 * id for the log, never either account id.
 */
export class MicrosoftAccountMismatchError extends Error {
  readonly userId: string;

  constructor(args: { userId: string; why: string }) {
    super(`this sign in is not the Microsoft account the Slate account belongs to (${args.why})`);
    this.name = "MicrosoftAccountMismatchError";
    this.userId = args.userId;
  }
}

/**
 * The codes the sign in callback bounces a refused Microsoft sign in back with, and
 * the sentence for each. The partner sign in page (`/partner/sign-in`, whose one button is
 * Microsoft) shows them, through `partner-sign-in-copy.ts`; the callback sends every
 * refused Microsoft sign in there, never to the staff page.
 */
export const MICROSOFT_NOT_INVITED_LOGIN_ERROR = "microsoft_not_invited";
export const MICROSOFT_NOT_INVITED_MESSAGE =
  "This Microsoft account doesn't have access to Slate. Ask your team lead to have Pennie grant your work address.";

export const MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR = "microsoft_account_changed";
export const MICROSOFT_ACCOUNT_CHANGED_MESSAGE =
  "This Microsoft account isn't the one your Slate access belongs to, so we couldn't sign you in. Ask your team lead to contact Pennie.";
