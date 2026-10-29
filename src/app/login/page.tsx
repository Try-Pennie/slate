"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { OAuthSignInButton } from "@/components/sign-in/OAuthSignInButton";
import { SignInErrorBanner } from "@/components/sign-in/SignInErrorBanner";
import { SignInFrame } from "@/components/sign-in/SignInFrame";
import { SIGN_IN_INCOMPLETE_MESSAGE, SIGN_IN_SETUP_RETRY_MESSAGE } from "@/lib/auth/sign-in-copy";
import {
  SESSION_IDLE_DAYS,
  SESSION_TIME_BOX_DAYS,
  sessionRefusalLoginError,
} from "@/lib/auth/session-age";
import {
  GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR,
  GOOGLE_ACCOUNT_CHANGED_MESSAGE,
  SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR,
  SEVERAL_GOOGLE_ACCOUNTS_MESSAGE,
} from "@/lib/auth/google-identity-copy";
import { PLACEHOLDER_ACCOUNT_LOGIN_ERROR, PLACEHOLDER_ACCOUNT_MESSAGE } from "@/lib/auth/landing";

// Sign-in failures the callback can bounce back with. Kept plain and
// non-technical; the domain case is the security gate from #589.
const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Please sign in with your Pennie Google account.",
  exchange_failed: SIGN_IN_INCOMPLETE_MESSAGE,
  missing_code: SIGN_IN_INCOMPLETE_MESSAGE,
  // #1648: provisioning refused rather than risk creating a second account for
  // this person. Worded as a retry, because that is what it is: nothing is wrong
  // with their account, a read failed or a simultaneous sign-in won the race.
  provision_failed: SIGN_IN_SETUP_RETRY_MESSAGE,
  // #2378: the account has been deactivated. Deliberately NOT worded as a retry,
  // unlike every other line here: signing in again can never work, and somebody
  // who has genuinely left should not be sent round the loop. It names the one
  // action that can change the answer, and says nothing about why.
  account_deactivated:
    "This Slate account is no longer active. Ask an admin to reactivate it if you still need access.",
  // #3526: a Google account other than the one this Slate account belongs to. Not
  // a retry either, for the same reason, and the wording lives with the rest of
  // that feature's copy.
  [GOOGLE_ACCOUNT_CHANGED_LOGIN_ERROR]: GOOGLE_ACCOUNT_CHANGED_MESSAGE,
  // #3526: two Google accounts attached to one sign in. Not a retry either: they
  // stay attached until an admin removes the old sign in.
  [SEVERAL_GOOGLE_ACCOUNTS_LOGIN_ERROR]: SEVERAL_GOOGLE_ACCOUNTS_MESSAGE,
  // #4205: the address is the placeholder advisor's, which nobody signs in as. Not
  // a retry: signing in again reaches the same row.
  [PLACEHOLDER_ACCOUNT_LOGIN_ERROR]: PLACEHOLDER_ACCOUNT_MESSAGE,
  // #3083: the deploy is missing its sign-in domain, so the callback refuses
  // everyone rather than letting any Google account in. Nothing the person does
  // can fix it, so it points at the people who can.
  sign_in_unavailable:
    "Sign in is unavailable right now. Please let a Slate admin know.",
  // #3084: a sign in that reached its age limit. Each says which limit, because
  // "you were signed out" alone reads as something having gone wrong.
  [sessionRefusalLoginError("time-box")]:
    `You were signed out because it has been ${SESSION_TIME_BOX_DAYS} days since you signed in. Please sign in again.`,
  [sessionRefusalLoginError("idle")]:
    `You were signed out because Slate was not used on this device for ${SESSION_IDLE_DAYS} days. Please sign in again.`,
  [sessionRefusalLoginError("unstamped")]:
    "You were signed out. Please sign in again.",
};

function LoginError() {
  const error = useSearchParams().get("error");
  // Own keys only: the code comes from the address, so `?error=__proto__` or
  // `?error=constructor` would otherwise find an inherited OBJECT and crash the page.
  const message = error && Object.hasOwn(ERROR_MESSAGES, error) ? ERROR_MESSAGES[error] : null;
  if (!message) return null;
  return <SignInErrorBanner message={message} />;
}

/**
 * The staff sign in page: Google only (#589). Its frame and its button are shared with
 * the partner sign in page (#4379, `src/components/sign-in/`), which offers Microsoft
 * instead; this page does not change for it (docs/design/partner-sign-in.html, D3).
 */
export default function LoginPage() {
  return (
    <SignInFrame>
      <h1 className="pn-h3">Sign in to Slate</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Sign in with your Pennie Google account to manage your calendar and
        availability.
      </p>
      <Suspense fallback={null}>
        <LoginError />
      </Suspense>
      <OAuthSignInButton provider="google" />
    </SignInFrame>
  );
}
