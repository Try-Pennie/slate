/**
 * Every sentence a person reads about which Google account a Slate account
 * belongs to (#3526), in one place so the sign in page, the advisor page and the
 * action behind it cannot drift into three ways of saying it.
 *
 * Two readers. Somebody refused at sign in, who may be a new hire on a reused
 * address or a returning advisor on a new Google account, and is told the one
 * thing that changes the answer: an admin. And the admin, who is told what
 * relinking does to the account before they do it (L180).
 */

/** The code the sign in callback bounces back with. */
export const GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR = "google_account_changed";

/**
 * Not worded as a retry, because signing in again with the same account can
 * never work (L111). It says nothing about whose account this address belonged
 * to: the reader may not be that person.
 */
export const GOOGLE_ACCOUNT_CHANGED_MESSAGE =
  "This Google account isn't the one this Slate account belongs to, so we couldn't sign you in. If you've been given a new Google account, ask a Slate admin to link it for you.";

/** The code the sign in callback bounces back with for two Google accounts on one sign in. */
export const SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR = "several_google_accounts";

/**
 * More than one Google account is attached to the sign in. Not a retry, which can
 * never work: the accounts stay attached until an admin removes the old sign in.
 */
export const SEVERAL_GOOGLE_ACCOUNTS_MESSAGE =
  "More than one Google account is attached to this sign in, so we couldn't sign you in. Please ask a Slate admin to sort it out for you.";

/** The admin control on the advisor's page. */
export const GOOGLE_RELINK_COPY = {
  /**
   * The domain fact a reader needs to know the control exists for, said once,
   * beside it (L604): why somebody can be locked out, and when this is the answer.
   */
  explanation: (name: string) =>
    `Slate only signs ${name} in with the Google account they have been using. If they come back on a new Google account, link it here so their next sign in is let through.`,
  /**
   * The same line for someone with a sign in on record but no Google account
   * recorded yet, which is the case a sign in holding no Google account, or two,
   * gets refused in. It claims only what is true of them.
   */
  signInOnlyExplanation: (name: string) =>
    `No Google account is recorded for ${name} yet. If they cannot sign in, link a new one here.`,
  openLabel: "Link a new Google account",
  question: (name: string) => `Link a new Google account for ${name}?`,
  /**
   * The consequence, derived from what the press changes (L180): the account is
   * handed to whoever signs in next with that address, which is the whole risk.
   */
  consequence: (name: string, email: string) =>
    `Slate forgets the Google account ${name} has been signing in with and signs it out everywhere. The next Google account that signs in as ${email} gets this Slate account, with its role and bookings, so only do this when you know who that will be.`,
  dismissLabel: "Keep their current account",
  confirmLabel: "Forget the old account",
  pendingLabel: "Forgetting the old account",
} as const;

/** What the advisor page says once the relink has landed. */
export const GOOGLE_RELINK_SAVED =
  "Their old Google account is forgotten. The next Google account that signs in with their address becomes theirs.";

/** Each refusal the relink action can speak, on the page the button is on. */
export const GOOGLE_RELINK_REFUSED = {
  nothingLinked:
    "Nothing was changed: no Google account is linked to this person, so their next sign in links one.",
  notPermitted: "Nothing was changed: changing this person's settings needs a role above theirs.",
  missing: "That person could not be found, so nothing was changed.",
  unreadable: "Nothing was changed: Slate could not read this person's record just now. Try again shortly.",
  // Relinking deletes the sign in the account runs on, so on your own account it
  // would sign you out for good.
  self: "Nothing was changed: you cannot link a new Google account to your own Slate account. Ask another admin.",
  signInNotRemoved:
    "Nothing was changed: Slate could not remove their old sign in just now, so the old Google account is still linked. Try again shortly.",
} as const;
