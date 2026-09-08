"use client";

import { useEffect } from "react";
import type { ThemePreference } from "@/lib/db/types";
import { applyThemePreference, readThemePreference } from "@/lib/theme/client";

/**
 * Keeps a System preference following the device for as long as the page is open
 * (#2100). Renders nothing.
 *
 * WHY IT IS NOT IN THE ACCOUNT MENU, which is where it used to live. The menu's
 * panel renders nothing while closed, so the component that owned this
 * subscription only existed while a popup was open, and its mount effect
 * re-applied the preference the page had been RENDERED with every time that
 * popup reopened. Somebody who chose Light, closed the menu and opened it again
 * watched the page go back to dark. It has to be mounted for the whole visit, so
 * it is mounted by the header rather than by anything that opens and closes.
 *
 * IT DOES NOT PAINT ON MOUNT, deliberately. The theme is already on the document
 * by then: the header's boot script applies it before the first paint. A mount
 * effect that applied `preference` again would be the same defect, because
 * `preference` is a copy taken when the page was rendered and a person can have
 * changed it since.
 *
 * The same reasoning is why the device listener re-reads the CURRENT preference
 * rather than closing over the prop: after somebody picks Light, this component's
 * prop still says system until the next full load, and a device flip would
 * otherwise repaint dark over a choice they had just made.
 */
export function ThemeSync({ preference }: { preference: ThemePreference }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = readThemePreference() ?? preference;
      if (current !== "system") return;
      applyThemePreference(current);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return null;
}
