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
 *
 * #1746: this was a native `<select>`, mounted inside the already-open account
 * menu, so choosing a theme opened a browser-drawn popup on top of the app's own
 * popup. Nothing about that second layer can be styled, so it read as a piece of
 * the operating system pasted into Slate. It is an inline segmented radio group
 * now: everything is visible and one click away, with no second layer.
 *
 * System stays as a real third choice rather than collapsing to an on/off
 * toggle, because it is not a midpoint between the other two: it tracks the
 * device and flips live when the OS does. A two-state toggle would silently pin
 * anyone who had been following their device to whichever value it landed on.
 *
 * Native radios sharing one `name` carry the accessibility contract: the browser
 * gives arrow-key roving and single selection, and assistive tech reads the
 * checked state. The inputs are visually hidden and the segment they label is
 * what gets painted, so the focus ring is drawn on the segment (`.pn-seg` in
 * globals.css) rather than on a 1px input.
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

/**
 * The no-flash cookie the root layout's inline script reads on the next load, so
 * a page does not paint in the old theme first. At module scope beside `apply`
 * for the same reason: both write to the document, and react-hooks/immutability
 * refuses a document write made from inside the component body.
 */
function remember(pref: ThemePreference) {
  document.cookie = `slate-theme=${pref}; path=/; max-age=31536000; samesite=lax`;
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
    remember(next);
    // swallow-ok: a client-side cosmetic preference. The toggle has already
    // applied the theme locally, so a failed persist only means the next visit
    // starts from the system default. This is a client component, so the
    // server-side logger is not available here anyway.
    void setThemePreference(next).catch(() => {});
  }

  return (
    <fieldset
      role="radiogroup"
      className="min-w-0 border-0 p-0"
    >
      <legend className="mb-1.5 text-xs font-semibold text-fg-muted">
        Theme
      </legend>
      <div className="flex gap-0.5 rounded-sm border border-border bg-[var(--bg-alt)] p-0.5">
        {OPTIONS.map((o) => {
          const selected = pref === o.value;
          return (
            <label
              key={o.value}
              className={`pn-seg relative flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-xs px-2 transition-colors ${
                selected ? "bg-accent" : "hover:bg-surface"
              }`}
            >
              <input
                type="radio"
                name="slate-theme-preference"
                value={o.value}
                checked={selected}
                onChange={() => choose(o.value)}
                className="pn-seg-input sr-only"
              />
              {/* Weight carries the selection alongside the fill, so the state is
                  never colour alone (WCAG 1.4.1). */}
              <span
                className={`text-sm ${
                  selected
                    ? "font-semibold text-fg-on-sky"
                    : "font-normal text-fg-muted"
                }`}
              >
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
