/**
 * The words both sign in pages share (#4379): the staff page, `/login`, and the partner
 * page, `/partner/sign-in`, draw the same photograph panel and the same sign in button,
 * so they read the same sentences from here rather than two copies drifting apart.
 *
 * The panel's words are the staff page's as they were; the partner page shows them too,
 * because its settled design draws the card inside the existing login page frame
 * (docs/design/partner-sign-in.html, "idioms"). Each page's own heading, line and refusal
 * sentences live with that page: `partner-sign-in-copy.ts` for the partner page.
 *
 * Pure, no imports.
 */

/** The photograph panel beside the card. */
export const SIGN_IN_PANEL_COPY = {
  welcome: "Welcome back.",
  line: "Manage your availability and let the right calls find you.",
} as const;

/** The sign in button, in each of its states (#626, #631). */
export const SIGN_IN_BUTTON_COPY = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
  /** While the browser is being handed to the provider. */
  working: "Redirecting…",
  /**
   * The sign in call itself never reached the provider (a network blip). Distinct from
   * the refusals a page shows after a redirect did happen.
   */
  unreachable: "We couldn't reach the sign-in service. Check your connection and try again.",
  /** Still not redirected after ten seconds: alive, with a way to start again. */
  stalled: "Taking longer than expected.",
  retry: "Try again",
} as const;

/**
 * A hand off that came back unfinished: no code, or a code that would not exchange.
 * Worded as a retry, because that is what it is.
 */
export const SIGN_IN_INCOMPLETE_MESSAGE = "That sign-in didn't complete. Please try again.";

/**
 * #1648: setting up or linking the account was refused rather than risk a second account
 * for this person. A retry too: a read failed, or a simultaneous sign in won the race.
 */
export const SIGN_IN_SETUP_RETRY_MESSAGE =
  "We couldn't finish setting up your account just now. Please try signing in again.";
