import type { ThemePreference } from "@/lib/db/types";

/**
 * One definition of "which theme does this person get" (#2100).
 *
 * There were three: inline script text in the root layout, a `resolve()` inside
 * the theme control, and a third for lead facing standalone pages. Each was
 * correct on its own, which is what made them dangerous: a rule written three
 * times drifts, and this rule drifts silently, because a page painting the wrong
 * theme reads as a preference nobody set rather than as a defect.
 *
 * The reason it cannot simply be a function everybody imports is that one of the
 * three has to run BEFORE the first paint, from markup, where nothing can be
 * imported. So the rule lives here once and is EMITTED as script text for that
 * case. `scripts/test-theme-boot.ts` runs the emitted string in a fake document
 * and requires it to reach the same answer as `resolveTheme` for every input,
 * because no compiler reads script text and nothing else could hold the two
 * halves together.
 */

export type ResolvedTheme = "light" | "dark";

/** The cookie the boot script reads. Written by the control and by the server. */
export const THEME_COOKIE = "slate-theme";

/** A year, matching the account row it mirrors: this is a cache, not a session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * What somebody gets when they have never chosen (Dan, 2026-09-08, #2100).
 *
 * It was `system`, which meant the product's look was decided by each person's
 * operating system. Light is now the product's answer, and `system` stays a
 * choice somebody can make rather than one made for them.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (PREFERENCES as readonly string[]).includes(value);
}

/**
 * Whose preference a session paints (#2100).
 *
 * The reported defect: while an admin was viewing as somebody else, the theme
 * control displayed the IMPERSONATED person's preference and its write went to
 * the ADMIN's account row. Each half was defensible alone, and together they
 * could never agree, so a choice looked like it had been discarded.
 *
 * The theme belongs to whoever is SIGNED IN. It is their screen: the person
 * being viewed as is not in the room. Structural parameter rather than
 * `ImpersonationView` so this stays reachable from the node suite, which cannot
 * pull the Supabase client behind an auth import.
 */
export function ownThemePreference(
  impersonation: { status: string; real?: { theme_preference: ThemePreference } | null },
  signedInPreference: ThemePreference,
): ThemePreference {
  if (impersonation.status === "active" && impersonation.real) {
    return impersonation.real.theme_preference;
  }
  return signedInPreference;
}

/** The rule, for everything that runs after hydration. */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * The same rule as script text. `readPreference` is a JavaScript EXPRESSION that
 * yields a preference; everything after it is shared, so the two callers below
 * cannot resolve differently from each other or from `resolveTheme`.
 */
function bootScript(readPreference: string, remember: boolean): string {
  return (
    `(function(){try{` +
    `var p=${readPreference};` +
    `var t=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;` +
    `document.documentElement.setAttribute('data-theme',t);` +
    (remember
      ? `document.cookie='${THEME_COOKIE}='+p+'; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax';`
      : ``) +
    `}catch(e){}})();`
  );
}

/**
 * Where the boot script should get the preference from.
 *
 * `cookie` is the root layout, which serves every surface including the lead
 * facing booker and so cannot know who is signed in. `preference` is a surface
 * whose server render already knows: the internal header (the signed in person's
 * own preference, never the one they are viewing as) and the standalone lead
 * pages (the theme the URL asked for).
 */
export type ThemeBootSource =
  | { kind: "cookie" }
  | {
      kind: "preference";
      preference: ThemePreference;
      /**
       * Also mirror this preference into the cookie, so the next load of any
       * surface (including the ones that cannot know who is signed in) starts
       * from it. ONLY the internal header sets this: it is the one place whose
       * preference came from the signed in person's own account row. A lead
       * following a `?theme=dark` link is not expressing an account preference,
       * so the standalone pages leave it off.
       */
      remember?: boolean;
    };

export function themeBootScript(source: ThemeBootSource): string {
  if (source.kind === "preference") {
    // Only a value from the union is ever embedded, so nothing a request can
    // influence reaches the script text.
    const safe = isThemePreference(source.preference)
      ? source.preference
      : DEFAULT_THEME_PREFERENCE;
    return bootScript(`'${safe}'`, source.remember === true);
  }

  // A cookie value outside the vocabulary is not a preference, so it falls back
  // to the default rather than being written onto the document (#2100).
  //
  // The legacy `localStorage` fallback this replaced is deliberately gone: the
  // cookie is written by the control, by the server action, at login, and by
  // ThemeSync on every internal page, so nothing signed in still depends on it,
  // and the booker never had one.
  const read =
    `(function(){` +
    `var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]+)/);` +
    `var v=m?decodeURIComponent(m[1]):null;` +
    `return (v==='system'||v==='light'||v==='dark')?v:'${DEFAULT_THEME_PREFERENCE}';` +
    `})()`;
  return bootScript(read, false);
}
