"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { ArrowRightIcon } from "@/components/icons";
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

// Sign-in failures the callback can bounce back with. Kept plain and
// non-technical; the domain case is the security gate from #589.
const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Please sign in with your Pennie Google account.",
  exchange_failed: "That sign-in didn't complete. Please try again.",
  missing_code: "That sign-in didn't complete. Please try again.",
  // #1648: provisioning refused rather than risk creating a second account for
  // this person. Worded as a retry, because that is what it is: nothing is wrong
  // with their account, a read failed or a simultaneous sign-in won the race.
  provision_failed:
    "We couldn't finish setting up your account just now. Please try signing in again.",
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

// Shown when the sign-in call itself never reaches Google (a transient network
// blip). Distinct from ERROR_MESSAGES, which cover errors the callback bounces
// back after a redirect did happen.
const SIGN_IN_FAILED_MESSAGE =
  "We couldn't reach the sign-in service. Check your connection and try again.";

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error"
    >
      {message}
    </p>
  );
}

function LoginError() {
  const error = useSearchParams().get("error");
  // Own keys only: the code comes from the address, so `?error=__proto__` or
  // `?error=constructor` would otherwise find an inherited OBJECT and crash the page.
  const message = error && Object.hasOwn(ERROR_MESSAGES, error) ? ERROR_MESSAGES[error] : null;
  if (!message) return null;
  return <ErrorBanner message={message} />;
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // A successful sign-in redirects to Google; if that hasn't happened by ~10s
  // the hand-off wedged, so surface a distinct still-alive state with a retry
  // instead of a button stuck on "Redirecting…" forever (#626). The redirect
  // can't be aborted, so this is a cue + retry rather than a timeout.
  const stalled = useStalledAfter(loading);

  async function signIn() {
    setSignInError(null);
    setLoading(true);
    const supabase = supabaseBrowser();
    const hd = process.env.NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN;
    // On success the browser redirects to Google and this component unmounts, so
    // loading stays true through the hand-off. A returned error or a throw means
    // the redirect never happened (#631): unwind loading and show the failure so
    // the only button doesn't stay stuck on "Redirecting…".
    try {
      // #1046: identity only. Slate reads calendars through domain-wide delegation
      // with a service account and stores no OAuth tokens for the person signing in
      // (nothing reads provider_token), so a calendar.events scope here would be a
      // write permission over every staff calendar that the app never exercises,
      // granted and re-consented on every single sign-in. `access_type=offline`
      // asked for a refresh token nothing keeps, and `prompt=consent` re-showed the
      // grant screen every time. The `hd` hint stays: it puts a person on the right
      // account picker, though the real domain gate is server side (#589).
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/api/auth/callback`,
          queryParams: hd ? { hd } : {},
        },
      });
      if (error) {
        setLoading(false);
        setSignInError(SIGN_IN_FAILED_MESSAGE);
      }
    } catch {
      setLoading(false);
      setSignInError(SIGN_IN_FAILED_MESSAGE);
    }
  }

  return (
    <main className="grid min-h-dvh flex-1 grid-rows-[auto_1fr] bg-bg lg:grid-cols-2 lg:grid-rows-1">
      <section className="relative hidden flex-col gap-6 overflow-hidden bg-pennie-navy p-8 sm:flex lg:justify-between lg:p-12">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative brand art; OpenNext/CF has no image loader */}
        <img
          src="/brand/login-art.webp"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center"
        />
        {/* Navy scrim: darkens the top + bottom so the cream wordmark and copy
            stay legible, while the concrete mark breathes through the middle. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-pennie-navy/85 via-pennie-navy/25 to-pennie-navy/90"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
        <img
          src="/brand/logo-pennie-cream.svg"
          alt="Pennie"
          className="relative z-10 h-[22px] w-auto self-start"
        />
        <div className="relative z-10 max-w-md">
          <p className="pn-h2 hidden text-pennie-beige lg:block">
            Welcome back.
          </p>
          <p className="text-lg leading-relaxed text-pennie-beige/80 lg:mt-4 lg:text-xl">
            Manage your availability and let the right calls find you.
          </p>
        </div>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm rounded-xl bg-surface p-8 shadow-xs">
          <div className="mb-8 sm:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
            <img
              src="/brand/logo-pennie-charcoal.svg"
              alt="Pennie"
              className="h-[22px] w-auto dark:hidden"
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- cream variant for the dark theme */}
            <img
              src="/brand/logo-pennie-cream.svg"
              alt="Pennie"
              className="hidden h-[22px] w-auto dark:block"
            />
          </div>
          <h1 className="pn-h3">Sign in to Slate</h1>
          <p className="mt-2 text-sm text-fg-muted">
            Sign in with your Pennie Google account to manage your calendar and
            availability.
          </p>
          <Suspense fallback={null}>
            <LoginError />
          </Suspense>
          {signInError && <ErrorBanner message={signInError} />}
          <button
            onClick={signIn}
            disabled={loading}
            className="group mt-8 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 text-base font-semibold text-fg-on-sky hover:bg-accent-hover active:translate-y-px disabled:opacity-60"
          >
            {loading ? "Redirecting…" : "Continue with Google"}
            {!loading && (
              <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-enabled:group-hover:translate-x-1" />
            )}
          </button>
          {loading && stalled && (
            <p role="status" className="mt-4 text-sm text-fg-muted">
              Taking longer than expected.{" "}
              <button
                type="button"
                onClick={() => {
                  setLoading(false);
                  signIn();
                }}
                className="font-semibold text-fg underline underline-offset-2 hover:no-underline"
              >
                Try again
              </button>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
