import { PLACEHOLDER_ACCOUNT_LOGIN_ERROR } from "./landing.ts";
import {
  MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR,
  MICROSOFT_ACCOUNT_CHANGED_MESSAGE,
  MICROSOFT_NOT_INVITED_LOGIN_ERROR,
  MICROSOFT_NOT_INVITED_MESSAGE,
} from "./microsoft-identity.ts";
import { SESSION_ENDED_MESSAGES, SIGN_IN_INCOMPLETE_MESSAGE, SIGN_IN_SETUP_RETRY_MESSAGE } from "./sign-in-copy.ts";
import { STAFF_SIGN_IN_PATH } from "./sign-in-page.ts";

/**
 * Every sentence the partner sign in page draws (#4379), where the call center partner's
 * scheduling coordinators sign in with their work Microsoft account.
 *
 * The heading and line are the settled design's, word for word
 * (docs/design/partner-sign-in.html, D2), and `docs/design/partner-sign-in.checks.js`
 * checks the built page says them. The refusals are beyond the design, for the codes the
 * sign in callback sends a Microsoft sign in back with, in the same voice: short sentences
 * for a reader whose first language may not be English, and, since a partner cannot know
 * who Pennie's Slate admins are, the person they can ask is their own team lead.
 */
export const PARTNER_SIGN_IN_COPY = {
  heading: "Sign in to book calls",
  line: "Sign in with your work Microsoft account to book calls for Pennie's customers.",
  /**
   * The photograph panel, in the partner's words rather than the staff page's (#4399,
   * docs/design/partner-sign-in-panel.html, D1 the headline and D2 the line).
   */
  panel: {
    headline: "Booking for Pennie.",
    line: "Help Pennie's customers talk to an advisor, now or at a time that suits them.",
  },
  /**
   * The quiet way out below the Microsoft button for a Pennie staff member who lands here on a
   * browser a coordinator used last (#4411, docs/design/partner-sign-in-staff-link.html, D1).
   * The lead ends in a space because the link follows it on the same line.
   */
  staffWay: {
    lead: "Pennie staff? ",
    link: { label: "Sign in on the staff page", href: STAFF_SIGN_IN_PATH },
  },
} as const;

/** What the page says for a refused sign in, and, where there is one, the way out. */
export interface SignInRefusal {
  message: string;
  link?: { label: string; href: string };
}

/**
 * One entry per code the callback can send here (`src/app/api/auth/callback/route.ts`), and
 * per code the middleware signs an aged session out with (`src/middleware.ts`).
 * Settled refusals are never worded as a retry (L111); the two unfinished hand offs and
 * a refused link are, because trying again is what helps.
 */
export const PARTNER_SIGN_IN_REFUSALS: Readonly<Record<string, SignInRefusal>> = Object.freeze({
  [MICROSOFT_NOT_INVITED_LOGIN_ERROR]: { message: MICROSOFT_NOT_INVITED_MESSAGE },
  [MICROSOFT_ACCOUNT_CHANGED_LOGIN_ERROR]: { message: MICROSOFT_ACCOUNT_CHANGED_MESSAGE },
  // A trypennie.com address through Microsoft: staff have their own page, and the only
  // useful thing to say is where it is.
  domain_not_allowed: {
    message: "This is a Pennie address. Pennie staff sign in with Google.",
    link: { label: "Go to the staff sign in page", href: STAFF_SIGN_IN_PATH },
  },
  account_deactivated: {
    message: "This Slate account is no longer active. If you still need access, ask your team lead to contact Pennie.",
  },
  [PLACEHOLDER_ACCOUNT_LOGIN_ERROR]: {
    message: "This address belongs to the placeholder advisor, which nobody signs in as. Sign in with your own work Microsoft account.",
  },
  sign_in_unavailable: {
    message: "Sign in is not working right now. Please ask your team lead to tell Pennie.",
  },
  provision_failed: { message: SIGN_IN_SETUP_RETRY_MESSAGE },
  exchange_failed: { message: SIGN_IN_INCOMPLETE_MESSAGE },
  missing_code: { message: SIGN_IN_INCOMPLETE_MESSAGE },
  // A session that reached its 30 or 7 day limit lands here (#4412) and says so in the staff
  // page's own words, read from the one place both pages share (#4409, Dan, 2026-10-29).
  ...Object.fromEntries(Object.entries(SESSION_ENDED_MESSAGES).map(([code, message]) => [code, { message }])),
});

/**
 * The refusal for a code from the address, or null for none. Own keys only: the code comes
 * from the URL, so `?error=__proto__` must find nothing rather than an inherited object.
 */
export function partnerSignInRefusal(code: string | null | undefined): SignInRefusal | null {
  return code && Object.hasOwn(PARTNER_SIGN_IN_REFUSALS, code) ? PARTNER_SIGN_IN_REFUSALS[code]! : null;
}
