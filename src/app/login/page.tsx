"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useStalledAfter } from "@/lib/useStalledAfter";
import { ArrowRightIcon } from "@/components/icons";

const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

// Sign-in failures the callback can bounce back with. Kept plain and
// non-technical; the domain case is the security gate from #589.
const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Please sign in with your Pennie Google account.",
  exchange_failed: "That sign-in didn't complete. Please try again.",
  missing_code: "That sign-in didn't complete. Please try again.",
};

function LoginError() {
  const error = useSearchParams().get("error");
  const message = error ? ERROR_MESSAGES[error] : null;
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-4 rounded-md border border-[var(--error)] bg-error/5 px-4 py-3 text-sm text-error"
    >
      {message}
    </p>
  );
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  // A successful sign-in redirects to Google; if that hasn't happened by ~10s
  // the hand-off wedged, so surface a distinct still-alive state with a retry
  // instead of a button stuck on "Redirecting…" forever (#626). The redirect
  // can't be aborted, so this is a cue + retry rather than a timeout.
  const stalled = useStalledAfter(loading);

  async function signIn() {
    setLoading(true);
    const supabase = supabaseBrowser();
    const hd = process.env.NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback`,
        scopes: CALENDAR_SCOPES,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
          ...(hd ? { hd } : {}),
        },
      },
    });
  }

  return (
    <main className="grid min-h-dvh flex-1 grid-rows-[auto_1fr] bg-bg lg:grid-cols-2 lg:grid-rows-1">
      <section className="relative hidden flex-col gap-6 overflow-hidden bg-pennie-navy p-8 sm:flex lg:justify-between lg:p-12">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative brand art; OpenNext/CF has no image loader */}
        <img
          src="/brand/login-art.jpg"
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
                className="font-semibold text-fg underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
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
