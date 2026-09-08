"use client";

import { useState } from "react";
import { setThemePreference } from "@/app/theme-actions";
import type { ThemePreference } from "@/lib/db/types";
import {
  applyThemePreference,
  readThemePreference,
  rememberThemePreference,
} from "@/lib/theme/client";

/**
 * Account-tied theme control. Three choices, System / Light / Dark, where System
 * follows the device and updates live if the OS flips. The choice is applied
 * instantly (data-theme + cookie) and persisted to the account by a server
 * action; the boot script in `@/lib/theme/boot` reads the cookie on the next
 * load so nothing flashes.
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
 *
 * #2100, TWO THINGS THIS NO LONGER DOES, and both were the same defect.
 *
 * It does not apply anything on mount, and it does not own the device
 * subscription. It lives inside a panel that renders nothing while closed, so
 * both of those only existed while a popup was open, and the mount effect
 * re-applied the preference the PAGE had been rendered with every time the popup
 * reopened: choose Light, close the menu, open it again, and the page went back
 * to dark. Painting before the first paint belongs to the boot script and
 * following the device belongs to ThemeSync, which the header mounts.
 *
 * Its selected value now comes from what this device last recorded rather than
 * from the prop, for the same reason: the prop is a copy taken when the page was
 * rendered, nothing revalidates it, and after a choice it is simply out of date.
 */

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle({
  preference,
}: {
  /** The signed in person's own account preference, as the page was rendered. */
  preference: ThemePreference;
}) {
  // The cookie is written by every path that changes this (here, the server
  // action, login, and the header's boot script), so it is the newest record of
  // what this browser is set to. The prop is the fallback for a device that has
  // no cookie yet.
  const [pref, setPref] = useState<ThemePreference>(
    () => readThemePreference() ?? preference,
  );
  const [unsaved, setUnsaved] = useState(false);

  function choose(next: ThemePreference) {
    setPref(next);
    setUnsaved(false);
    applyThemePreference(next);
    rememberThemePreference(next);
    // The apply and the cookie above already happened, so this browser keeps the
    // choice whatever the account write does. What a failure costs is the NEXT
    // sign in and every other device, which is why it is said out loud rather
    // than swallowed: before #2100 a write that never landed was indistinguishable
    // from one that did.
    void setThemePreference(next).catch(() => setUnsaved(true));
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
      {unsaved && (
        <p role="status" className="mt-1.5 text-xs text-fg-muted">
          Saved on this device only. Your account did not record it, so your next
          sign in starts from your old theme.
        </p>
      )}
    </fieldset>
  );
}
