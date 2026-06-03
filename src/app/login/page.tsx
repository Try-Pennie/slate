"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

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
    <main className="flex min-h-full flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Slate</h1>
        <p className="text-sm text-neutral-500">
          Sign in with your Pennie Google account to manage buckets, agents, and
          availability.
        </p>
        <button
          onClick={signIn}
          disabled={loading}
          className="w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </main>
  );
}
