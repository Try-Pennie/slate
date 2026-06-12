"use client";

import { useEffect, useState } from "react";
import { setThemePreference } from "@/app/theme-actions";
import type { ThemePreference } from "@/lib/db/types";

/**
 * Account-tied theme control. Three choices — System / Light / Dark — where
 * System follows the device's `prefers-color-scheme` and updates live if the OS
 * flips. The choice is applied instantly (data-theme + cookie) and persisted to
 * the user's account via a server action; the no-flash script in layout.tsx
 * reads the cookie on the next load. Initial value comes from the account.
 */

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

function apply(pref: ThemePreference) {
  document.documentElement.setAttribute("data-theme", resolve(pref));
}

export function ThemeToggle({
  preference = "system",
}: {
  preference?: ThemePreference;
}) {
  const [pref, setPref] = useState<ThemePreference>(preference);

  // Reconcile to the account preference on mount (covers a new device where the
  // cookie wasn't seeded yet) and, while on System, track live OS changes.
  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function choose(next: ThemePreference) {
    setPref(next);
    apply(next);
    document.cookie = `slate-theme=${next}; path=/; max-age=31536000; samesite=lax`;
    void setThemePreference(next).catch(() => {});
  }

  return (
    <label className="inline-flex items-center">
      <span className="sr-only">Theme</span>
      <select
        aria-label="Theme"
        value={pref}
        onChange={(e) => choose(e.target.value as ThemePreference)}
        className="min-h-11 cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 text-sm text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg focus-visible:border-border"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
