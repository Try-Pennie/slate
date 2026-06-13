"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { ArrowRightIcon } from "@/components/icons";

const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

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
      <section className="hidden flex-col gap-6 bg-pennie-navy p-8 sm:flex lg:justify-between lg:p-12">
        {/* eslint-disable-next-line @next/next/no-img-element -- concrete-fill SVG logo; OpenNext/CF has no image loader */}
        <img
          src="/brand/logo-pennie-cream.svg"
          alt="Pennie"
          className="h-[22px] w-auto self-start"
        />
        <div className="max-w-md">
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
        </div>
      </section>
    </main>
  );
}
