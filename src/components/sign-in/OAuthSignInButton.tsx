"use client";

import { useState } from "react";
import type { SignInWithOAuthCredentials } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { ArrowRightIcon } from "@/components/icons";
import type { SignInProvider } from "@/lib/auth/account-identity";
import { MICROSOFT_PROVIDER } from "@/lib/auth/microsoft-identity";
import { SIGN_IN_BUTTON_COPY as COPY } from "@/lib/auth/sign-in-copy";
import { signInFromCookie } from "@/lib/auth/sign-in-page";
import { SignInErrorBanner } from "./SignInErrorBanner";

/**
 * The sign in button both sign in pages use (#4379): Google on `/login` for staff, and
 * Microsoft on the partner page for invited coordinators. One component, so the two can
 * never come to differ in the three states every time taking action shows (CLAUDE.md):
 * working ("Redirecting…"), failed (an alert, the button back), and still working after
 * ten seconds with a retry.
 *
 * Renders the failure banner, then the button, then the stall cue, which is the order the
 * staff page always drew them in.
 */
export function OAuthSignInButton({ provider }: { provider: SignInProvider }) {
  const [loading, setLoading] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // A successful sign-in redirects to the provider; if that hasn't happened by ~10s
  // the hand-off wedged, so surface a distinct still-alive state with a retry
  // instead of a button stuck on "Redirecting…" forever (#626). The redirect
  // can't be aborted, so this is a cue + retry rather than a timeout.
  const stalled = useStalledAfter(loading);

  async function signIn() {
    setSignInError(null);
    setLoading(true);
    // On success the browser redirects to the provider and this component unmounts, so
    // loading stays true through the hand-off. A returned error or a throw means
    // the redirect never happened (#631): unwind loading and show the failure so
    // the only button doesn't stay stuck on "Redirecting…".
    try {
      // #4379: say which page this sign in started from, before the redirect, since
      // nothing on this page runs after it. The callback reads it only when nothing
      // better can say where a refusal belongs.
      document.cookie = signInFromCookie(provider === MICROSOFT_PROVIDER ? "partner" : "staff", window.location.protocol);
      const { error } = await supabaseBrowser().auth.signInWithOAuth(oauthRequest(provider));
      if (error) {
        setLoading(false);
        setSignInError(COPY.unreachable);
      }
    } catch {
      setLoading(false);
      setSignInError(COPY.unreachable);
    }
  }

  return (
    <>
      {signInError && <SignInErrorBanner message={signInError} />}
      <button
        onClick={signIn}
        disabled={loading}
        className="group mt-8 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 text-base font-semibold text-fg-on-sky hover:bg-accent-hover active:translate-y-px disabled:opacity-60"
      >
        {loading ? COPY.working : provider === MICROSOFT_PROVIDER ? COPY.microsoft : COPY.google}
        {!loading && (
          <ArrowRightIcon className="h-4 w-4 transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-enabled:group-hover:translate-x-1" />
        )}
      </button>
      {loading && stalled && (
        <p role="status" className="mt-4 text-sm text-fg-muted">
          {COPY.stalled}{" "}
          <button
            type="button"
            onClick={() => {
              setLoading(false);
              signIn();
            }}
            className="font-semibold text-fg underline underline-offset-2 hover:no-underline"
          >
            {COPY.retry}
          </button>
        </p>
      )}
    </>
  );
}

/**
 * What each provider is asked for. Both come back through the one callback, which decides
 * from the identities on the auth user, never from anything sent from here.
 */
function oauthRequest(provider: SignInProvider): SignInWithOAuthCredentials {
  const redirectTo = `${window.location.origin}/api/auth/callback`;
  if (provider === MICROSOFT_PROVIDER) {
    // #4379: the address alone. Slate reads nothing from the coordinator's Microsoft
    // account, and Supabase asks for openid and profile itself.
    return { provider, options: { scopes: "email", redirectTo } };
  }
  // #1046: identity only. Slate reads calendars through domain-wide delegation
  // with a service account and stores no OAuth tokens for the person signing in
  // (nothing reads provider_token), so a calendar.events scope here would be a
  // write permission over every staff calendar that the app never exercises,
  // granted and re-consented on every single sign-in. `access_type=offline`
  // asked for a refresh token nothing keeps, and `prompt=consent` re-showed the
  // grant screen every time. The `hd` hint stays: it puts a person on the right
  // account picker, though the real domain gate is server side (#589).
  const hd = process.env.NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN;
  return { provider, options: { redirectTo, queryParams: hd ? { hd } : {} } };
}
