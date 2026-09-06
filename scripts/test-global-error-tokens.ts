// #1958: the fatal error screen's hand copied colour values.
//
// `src/app/global-error.tsx` renders its OWN document, so it never receives
// `globals.css` and cannot reference a single token. Its five colours are
// therefore quoted by value, twice, once per theme.
//
// That copy drifted the first time anything moved. #1958 brought the dark
// surface ladder down and this file was left naming the page ground and card
// surface the theme had BEFORE, so the one screen a person reaches when
// everything else has already failed would have rendered in the old theme, on
// its own, looking entirely deliberate.
//
// It cannot be derived (that is the whole constraint), so it is guarded: each
// value here has to be one `globals.css` actually defines for the same role in
// the same theme. Nothing about this can be checked by looking at either file
// alone, which is why it had no check at all.
//
// Run: node --experimental-strip-types scripts/test-global-error-tokens.ts
import { readFileSync } from "node:fs";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const CSS = readFileSync("src/app/globals.css", "utf8");
const TSX = readFileSync("src/app/global-error.tsx", "utf8");

/** Every `--name: value;` inside one brace-delimited scope of the stylesheet. */
function scope(open: RegExp): Map<string, string> {
  const at = CSS.search(open);
  if (at < 0) throw new Error(`scope ${open} not found in globals.css`);
  const from = CSS.indexOf("{", at);
  let depth = 0;
  let to = from;
  for (; to < CSS.length; to++) {
    if (CSS[to] === "{") depth++;
    else if (CSS[to] === "}" && --depth === 0) break;
  }
  const out = new Map<string, string>();
  for (const m of CSS.slice(from, to).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const ROOT = scope(/^:root\s*\{/m);
const DARK = scope(/^\[data-theme="dark"\]\s*\{/m);

/** Resolve a token to a literal, following `var(--x)` aliases in the same
 *  theme first and falling back to `:root`, which is how the cascade reads it. */
function resolve(name: string, dark: boolean, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`alias loop at ${name}`);
  seen.add(name);
  const raw = (dark ? DARK.get(name) : undefined) ?? ROOT.get(name);
  if (!raw) throw new Error(`globals.css defines no ${name}`);
  const alias = raw.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolve(alias[1], dark, seen) : raw;
}

const norm = (v: string) => v.replace(/\s+/g, "");

/** The two theme blocks inside global-error's inline stylesheet. The dark one
 *  is inside a `prefers-color-scheme` media query, so it is taken as the text
 *  AFTER that query opens and the light one as the text before it. */
function inlineScopes(): { light: Map<string, string>; dark: Map<string, string> } {
  const at = TSX.indexOf("@media (prefers-color-scheme: dark)");
  assert(at > 0, "global-error still carries a dark media query");
  const grab = (text: string) => {
    const out = new Map<string, string>();
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
    return out;
  };
  return { light: grab(TSX.slice(0, at)), dark: grab(TSX.slice(at)) };
}

const inline = inlineScopes();

/**
 * Which stylesheet token each of the screen's own names is quoting.
 *
 * The screen names its colours by ROLE (`--ground`, `--card`) rather than by
 * token, deliberately: it holds five values and the stylesheet holds hundreds.
 * The mapping is the thing that was recorded nowhere.
 */
const QUOTES: { local: string; token: string }[] = [
  { local: "--ground", token: "--bg" },
  { local: "--ink", token: "--fg" },
  { local: "--card", token: "--surface" },
  { local: "--edge", token: "--border" },
  { local: "--action", token: "--accent" },
];

for (const { local, token } of QUOTES) {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const quoted = (dark ? inline.dark : inline.light).get(local);
    if (!quoted) {
      fail(`global-error still declares ${local} in ${theme}`);
      continue;
    }
    eq(
      norm(quoted),
      norm(resolve(token, dark)),
      `global-error's ${local} (${theme}) is what globals.css gives ${token}`,
    );
  }
}

// The mapping itself has to stay complete: a SIXTH colour added to the screen
// and left out of the table above would be unguarded, and an unguarded value is
// exactly what this suite exists to make impossible. So the count is asserted
// from the file rather than trusted.
for (const dark of [false, true]) {
  const found = [...(dark ? inline.dark : inline.light).keys()];
  eq(
    found.length,
    QUOTES.length,
    `global-error declares ${QUOTES.length} colours in ${dark ? "dark" : "light"}, all of them checked above (found ${found.join(", ")})`,
  );
}

// A positive control, because a resolver that read NOTHING would report the same
// clean run as a file in perfect step (L98). The dark page ground and the light
// one must not be the same value: if they are, `resolve` is ignoring the theme
// and every assertion above is comparing a token against itself.
{
  const lightGround = norm(resolve("--bg", false));
  const darkGround = norm(resolve("--bg", true));
  assert(
    lightGround !== darkGround,
    `the resolver reads the dark scope (light ${lightGround} vs dark ${darkGround})`,
  );
}

finish();
