// One rule for "which theme does this person get", and the proof that the
// version which runs BEFORE hydration agrees with the version TypeScript runs
// (#2100).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-theme-boot.ts
//
// The rule had three copies: inline script text in the root layout, a `resolve()`
// in the theme control, and a third for lead facing standalone pages. Three
// copies of one rule drift, and this one drifts silently: a page painting the
// wrong theme looks like a preference nobody set rather than like a defect.
//
// The awkward part is that ONE of the copies has to be a string. Nothing can be
// imported into a script that must run before the first paint, so the builder
// EMITS that string, and this suite runs the emitted string in a fake document
// and requires it to reach the same answer as the TypeScript resolver for every
// input. That is the only thing that can hold the two halves together, because
// no compiler reads script text.
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COOKIE,
  ownThemePreference,
  resolveTheme,
  themeBootScript,
  type ResolvedTheme,
} from "@/lib/theme/boot";
import type { ThemePreference } from "@/lib/db/types";

const PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

/**
 * Run an emitted boot script the way a browser would: a document with a cookie
 * string and a root element, plus the media query it asks about. Returns what
 * the script left on the root, or null if it set nothing.
 */
function run(
  script: string,
  { cookie, prefersDark }: { cookie: string; prefersDark: boolean },
): { applied: string | null; wrote: string | null } {
  let applied: string | null = null;
  let wrote: string | null = null;
  const sandbox = {
    document: {
      get cookie() {
        return cookie;
      },
      set cookie(v: string) {
        wrote = v;
      },
      documentElement: {
        setAttribute(name: string, value: string) {
          if (name === "data-theme") applied = value;
        },
      },
    },
    matchMedia: (q: string) => ({ matches: q.includes("dark") && prefersDark }),
    localStorage: { getItem: () => null },
  };
  vm.createContext(sandbox);
  new vm.Script(script).runInContext(sandbox);
  return { applied, wrote };
}

function runScript(
  script: string,
  args: { cookie: string; prefersDark: boolean },
): string | null {
  return run(script, args).applied;
}

// The product decision (#2100, Dan on 2026-09-08): light is what somebody gets
// when they have never chosen, rather than whatever their device is set to.
eq(
  DEFAULT_THEME_PREFERENCE,
  "light" as ThemePreference,
  "the default preference is light, not system",
);

// The resolver itself, which is the half tsc can see.
eq(resolveTheme("system", true), "dark" as ResolvedTheme, "system resolves to dark on a dark device");
eq(resolveTheme("system", false), "light" as ResolvedTheme, "system resolves to light on a light device");
eq(resolveTheme("dark", false), "dark" as ResolvedTheme, "dark is dark whatever the device says");
eq(resolveTheme("light", true), "light" as ResolvedTheme, "light is light whatever the device says");

// The half tsc CANNOT see: the emitted string, run for real, against the same
// inputs. Every combination, because the disagreement that matters is the one
// nobody thought to check.
for (const preference of PREFERENCES) {
  for (const prefersDark of [true, false]) {
    const fromCookie = runScript(themeBootScript({ kind: "cookie" }), {
      cookie: `${THEME_COOKIE}=${preference}`,
      prefersDark,
    });
    eq(
      fromCookie,
      resolveTheme(preference, prefersDark),
      `the cookie script agrees with the resolver for ${preference} on a ${prefersDark ? "dark" : "light"} device`,
    );

    const fromPreference = runScript(themeBootScript({ kind: "preference", preference }), {
      cookie: "",
      prefersDark,
    });
    eq(
      fromPreference,
      resolveTheme(preference, prefersDark),
      `the preference script agrees with the resolver for ${preference} on a ${prefersDark ? "dark" : "light"} device`,
    );
  }
}

// The hole this closes (#2100): the old script returned early with no cookie, so
// a session that never came through the OAuth callback painted whatever the
// static attribute said and was then re-themed by the account menu opening.
for (const prefersDark of [true, false]) {
  eq(
    runScript(themeBootScript({ kind: "cookie" }), { cookie: "", prefersDark }),
    resolveTheme(DEFAULT_THEME_PREFERENCE, prefersDark),
    `a session with no cookie paints the default on a ${prefersDark ? "dark" : "light"} device`,
  );
}

// A cookie holding something that is not a preference is not a preference.
eq(
  runScript(themeBootScript({ kind: "cookie" }), { cookie: `${THEME_COOKIE}=purple`, prefersDark: true }),
  resolveTheme(DEFAULT_THEME_PREFERENCE, true),
  "an unreadable cookie value falls back to the default rather than being written through",
);

// Another cookie sitting beside ours must not be read as ours.
eq(
  runScript(themeBootScript({ kind: "cookie" }), {
    cookie: `other-slate-theme=dark; ${THEME_COOKIE}=light`,
    prefersDark: true,
  }),
  "light" as ResolvedTheme,
  "the cookie is matched on its own name, not as a substring of a neighbour's",
);

// SEEDING THE COOKIE (#2100). The internal header knows who is signed in, so its
// boot script is what mirrors the account onto this device: before paint, once
// per document load, from the server's value. That is what closes the hole where
// a session whose cookie was never seeded (a dev preview, a cleared cookie jar,
// a session older than the feature) painted the default and was re-themed later
// by whatever mounted next.
{
  const { wrote } = run(
    themeBootScript({ kind: "preference", preference: "dark", remember: true }),
    { cookie: "", prefersDark: false },
  );
  assert(wrote !== null, "the remembering script writes a cookie");
  assert(
    (wrote ?? "").startsWith(`${THEME_COOKIE}=dark`),
    "it writes the preference it was given, under the name the reader looks for",
  );
  assert((wrote ?? "").includes("path=/"), "the cookie is written for the whole site");
  assert((wrote ?? "").includes("samesite=lax"), "the cookie carries samesite=lax");

  // A lead viewing ?theme=dark is not somebody expressing an account
  // preference, so the standalone page must NOT write one: doing so would let a
  // link a lead followed change what a signed in person sees next.
  const standalone = run(themeBootScript({ kind: "preference", preference: "dark" }), {
    cookie: "",
    prefersDark: false,
  });
  eq(standalone.wrote, null, "a script without `remember` writes no cookie");
  eq(standalone.applied, "dark" as ResolvedTheme, "and still paints the theme it was given");
}

// WHOSE PREFERENCE (#2100). The measured cause of the reported defect: the
// control READ the impersonated person's preference and WROTE the admin's
// account, so under "view as" the two halves could never agree. The theme a
// session paints belongs to whoever is signed in, never to whoever they are
// looking at, and this is the rule the header applies.
{
  const admin = { theme_preference: "dark" as ThemePreference };
  eq(
    ownThemePreference({ status: "active", real: admin }, "system"),
    "dark" as ThemePreference,
    "while viewing as somebody, the session paints the signed in person's own preference",
  );
  eq(
    ownThemePreference({ status: "none" }, "system"),
    "system" as ThemePreference,
    "signed in as yourself, it is your own preference",
  );
  eq(
    ownThemePreference({ status: "dropped" }, "dark"),
    "dark" as ThemePreference,
    "a dropped impersonation is nobody else's preference either",
  );
}

// POSITIVE CONTROL. Everything above compares two things that are supposed to
// agree, and a comparison whose two sides cannot disagree proves nothing (L1).
// So: break the emitted script the way a drifting copy would break it, and
// require the same comparison to catch it.
{
  const broken = themeBootScript({ kind: "cookie" }).replace(/'dark'/g, "'light'");
  assert(
    broken !== themeBootScript({ kind: "cookie" }),
    "the control really did modify the emitted script (otherwise it proves nothing)",
  );
  const appliedByBroken = runScript(broken, { cookie: `${THEME_COOKIE}=system`, prefersDark: true });
  assert(
    appliedByBroken !== resolveTheme("system", true),
    "a boot script that resolves differently from the resolver is caught by this comparison",
  );
}

// CONSOLIDATION GUARD (L613). Converting the three sites is only half the job:
// without this, the next hand rolled `data-theme` writer is invisible, and a
// fourth copy of the rule is exactly what this change exists to prevent.
{
  // TWO files, both under src/lib/theme: the builder that emits the script that
  // runs before hydration, and the runtime half the two client components call.
  // A component that writes data-theme itself is a fourth copy of the rule.
  const ALLOWED = new Set([
    "src/lib/theme/boot.ts",
    "src/lib/theme/client.ts",
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  const writers = walk("src")
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => /setAttribute\(\s*["']data-theme["']/.test(readFileSync(p, "utf8")));
  const stray = writers.filter((p) => !ALLOWED.has(p));

  eq(
    stray.join(", "),
    "",
    "every place that writes data-theme is one of the two that are allowed to",
  );
  assert(
    writers.length > 0,
    "the scan really found the writers it is judging (a scan that matched nothing passes by accident)",
  );
}

finish();
