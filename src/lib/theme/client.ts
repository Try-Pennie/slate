import type { ThemePreference } from "@/lib/db/types";
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  isThemePreference,
  resolveTheme,
} from "@/lib/theme/boot";

/**
 * The runtime half of the one theme rule (#2100), for the two client components
 * that legitimately repaint after hydration: the control (somebody just chose)
 * and ThemeSync (the device just changed).
 *
 * Everything else reads the theme from the document, which the boot script in
 * `@/lib/theme/boot` painted before the first paint. `scripts/test-theme-boot.ts`
 * fails the build on a `data-theme` write outside these two files, because a
 * fourth hand rolled copy of this rule is exactly what #2100 was.
 */

/** The preference this browser last recorded, or null when there is none. */
export function readThemePreference(): ThemePreference | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]+)`),
  );
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return isThemePreference(value) ? value : null;
}

/**
 * Record the preference on this device, so the next load paints it before the
 * first paint instead of flashing. The account row is the durable record; this
 * is the copy the boot script can read with no database.
 */
export function rememberThemePreference(preference: ThemePreference): void {
  document.cookie = `${THEME_COOKIE}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}

/** Paint a preference onto the document, resolving System against the device. */
export function applyThemePreference(preference: ThemePreference): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute(
    "data-theme",
    resolveTheme(preference, prefersDark),
  );
}
