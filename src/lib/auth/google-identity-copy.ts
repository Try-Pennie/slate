/**
 * The sentence a person reads when their sign in is refused because its Google
 * account is not the one their Slate account belongs to (#3526), and the code the
 * sign in callback bounces back with to ask for it.
 *
 * The reader may be a new hire on a reused address or a returning advisor on a
 * new Google account, and is told the one thing that changes the answer: an
 * admin.
 */

/** The code the sign in callback bounces back with. */
export const GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR = "google_account_changed";

/**
 * Not worded as a retry, because signing in again with the same account can
 * never work (L111). It says nothing about whose account this address belonged
 * to: the reader may not be that person.
 *
 * Drawn by the sign in page's error banner once that page maps the code above to
 * it, a screen change held for a design decision on #3526. Until then the code
 * reaches a page that has no sentence for it.
 */
export const GOOGLE_ACCOUNT_CHANGED_MESSAGE =
  "This Google account isn't the one this Slate account belongs to, so we couldn't sign you in. If you've been given a new Google account, ask a Slate admin to link it for you.";
