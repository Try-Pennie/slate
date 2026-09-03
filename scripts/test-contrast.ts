// Contrast guard: asserts the DISCOVERY D17 token pairings meet their WCAG 2.x
// ratios so a future token edit can't silently break AA. Reads the REAL resolved
// values out of the ported Pennie tokens in src/app/globals.css (no hardcoded
// parallel copy that can drift), resolving var() aliases and throwing loudly if
// a token is missing or the file moves. The light :root block and the
// [data-theme="dark"] flip are parsed separately so the dark --error override
// can't shadow the light rose. Also encodes the Pill pairings + dark error
// tokens flagged by the Phase 3 verification sweep.
// Run via pnpm test (auto-discovered).
// Run: node --experimental-strip-types scripts/test-contrast.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";

type RGB = [number, number, number];

// --- Token parsing ----------------------------------------------------------
const TOKEN_FILE = join("src", "app", "globals.css");
const CSS = readFileSync(TOKEN_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function extractBlock(selectorRe: RegExp, label: string): string {
  const m = CSS.match(selectorRe);
  if (!m) throw new Error(`${label} block not found in ${TOKEN_FILE}`);
  return m[1];
}

function buildMap(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

const ROOT = buildMap(extractBlock(/:root\s*\{([\s\S]*?)\n\}/, ":root"));
const DARK = buildMap(
  extractBlock(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/, '[data-theme="dark"]'),
);

function parseColor(v: string): RGB {
  const rgb = v.match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  const hex = v.match(/#([0-9a-f]{6})\b/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`cannot parse color: ${v}`);
}

/** Resolve a token to RGB, following var() aliases through the given scopes. */
function resolveIn(scopes: Map<string, string>[], name: string, seen = new Set<string>()): RGB {
  if (seen.has(name)) throw new Error(`cyclic token ${name}`);
  seen.add(name);
  const v = scopes.find((s) => s.has(name))?.get(name);
  if (!v) throw new Error(`token ${name} not found in ${TOKEN_FILE}`);
  const varRef = v.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (varRef) return resolveIn(scopes, varRef[1], seen);
  return parseColor(v);
}

/** Light theme: :root only. */
function r(name: string): RGB {
  return resolveIn([ROOT], name);
}
/** Dark theme: [data-theme="dark"] overrides, falling back to :root. */
function rDark(name: string): RGB {
  return resolveIn([DARK, ROOT], name);
}

// --- WCAG 2.x relative luminance + contrast ratio ---------------------------
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([red, green, blue]: RGB): number {
  return 0.2126 * lin(red) + 0.7152 * lin(green) + 0.0722 * lin(blue);
}
function ratio(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// The harness takes (condition, message). Passing the message alone made every
// passing line print "ok: undefined", so the ratios this guard exists to record
// reached nobody, and the only readable output was a failure. The numbers are the
// point: an issue asking for a colour to be re-measured is answered by running
// this and reading it.
function atLeast(fg: RGB, bg: RGB, min: number, label: string) {
  const v = ratio(fg, bg);
  const said = `${label} = ${v.toFixed(2)}:1`;
  if (v + 1e-9 >= min) assert(true, `${said} (>= ${min})`);
  else fail(`${said} (needs >= ${min})`);
}
function below(fg: RGB, bg: RGB, max: number, label: string) {
  const v = ratio(fg, bg);
  const said = `${label} = ${v.toFixed(2)}:1`;
  if (v < max) assert(true, `${said} (correctly < ${max}, forbidden)`);
  else fail(`${said} (expected < ${max}, the token may have changed)`);
}

// --- Tokens under test (read by name; missing names throw) ------------------
const graphite = r("--pennie-graphite");
const sky = r("--pennie-sky");
const skyDeep = r("--pennie-sky-deep");
const skyHover = r("--accent-hover"); // #6dc5f7, tokenized in Task 1.2 (S4)
const beige = r("--pennie-beige");
const white = r("--pennie-white");
const navy = r("--pennie-navy");
const muted = r("--pennie-muted");
const rose = r("--error"); // :root --error -> --pennie-rose (S1)
const blue = r("--pennie-blue");

// --- D17: text pairings that must PASS 4.5:1 --------------------------------
atLeast(graphite, sky, 4.5, "PRIMARY CTA graphite-on-sky"); // 7.36
atLeast(graphite, skyHover, 4.5, "CTA label on hover sky"); // 6.51
atLeast(graphite, beige, 4.5, "body graphite-on-beige"); // 11.54
atLeast(graphite, white, 4.5, "graphite-on-white"); // 12.45
atLeast(white, navy, 4.5, "white-on-navy band"); // 16.02
atLeast(beige, navy, 4.5, "beige-on-navy (fg-on-ink)"); // 14.85
atLeast(muted, beige, 4.5, "muted-on-beige (thin 4.98 pass guard)");
atLeast(rose, beige, 4.5, "error rose-on-beige"); // 4.77
atLeast(blue, beige, 4.5, "blue text-on-beige (only passing blue on light)"); // 4.56
atLeast(blue, white, 4.5, "blue text-on-white"); // 4.91

// --- D17 / #1768: the focus ring, on EVERY surface it can be drawn on -------
//
// One recipe, but the ring COLOUR is chosen by the surface rather than by the
// theme, and that is not a preference: no single token clears 3:1 everywhere.
// Measured with this resolver, worst case per candidate:
//
//   candidate       light worst           dark worst
//   sky             1.57 on beige         1.00 on a sky fill
//   sky-deep        1.70 on a sky fill    1.70 on a sky fill
//   blue            2.91 on a sky fill    1.85 on surface-elevated
//   graphite        7.36 on a sky fill    1.06 on dark surface
//
// So: brand blue on ordinary LIGHT surfaces (it reads as brand rather than as a
// hard black box), graphite wherever the ring lands on a SKY or accent fill (the
// primary CTA is sky by design and is one of the most focused controls in the
// product), and sky on DARK. Each of the three is asserted against every surface
// it can actually meet, in the theme it meets it in.
const blueRing = r("--focus-ring-line");
const accentRing = r("--focus-ring-line-on-accent");
const darkRing = rDark("--focus-ring-line");

// Ordinary light surfaces.
for (const [name, surface] of [
  ["page beige", r("--bg")],
  ["hover and zebra tint", r("--bg-alt")],
  ["card surface", r("--surface")],
  ["elevated surface", r("--surface-elevated")],
  ["the sidebar current item's sky wash", r("--pennie-sky-soft")],
] as [string, RGB][]) {
  atLeast(blueRing, surface, 3, `focus line on ${name} (light)`);
}

// Surfaces that paint their own sky or accent fill, in EITHER theme, where the
// ring flips to graphite. A ring on a focused primary button has to clear against
// the button, not against the page behind it (L213).
for (const [name, surface] of [
  ["a sky fill", sky],
  ["a sky fill on hover", skyHover],
  ["a pressed sky fill", skyDeep],
] as [string, RGB][]) {
  atLeast(accentRing, surface, 3, `focus line on ${name} (either theme)`);
}

// Ordinary dark surfaces.
for (const [name, surface] of [
  ["the navy page", rDark("--bg")],
  ["a dark hover tint", rDark("--bg-alt")],
  ["a dark card", rDark("--surface")],
  ["a dark elevated surface", rDark("--surface-elevated")],
] as [string, RGB][]) {
  atLeast(darkRing, surface, 3, `focus line on ${name} (dark)`);
}

// --- #1768: the three failures that shaped the recipe, held as tripwires ----
//
// The positive control for the block above. Every one of these is a colour
// somebody would reasonably reach for, and each must STAY below the line, or the
// assertions above are passing for a reason nobody has checked.
below(sky, beige, 3, "sky as a focus line on beige - why 25 per component rings were deleted");
below(sky, white, 3, "sky as a focus line on white - the same failure on a card");
below(blueRing, sky, 3, "brand blue on a SKY fill - why an accent fill flips the ring to graphite");
below(blueRing, rDark("--surface-elevated"), 3, "brand blue on a dark elevated surface - why dark keeps sky");
below(graphite, rDark("--surface"), 3, "graphite on a dark card - why graphite is light only");

// --- #1792: the internal working cue's arc, on every surface it can land on --
//
// A thin line drawn on a surface, so the same problem as the focus ring above and
// the same answer. Asserted BY ITS OWN NAME rather than left to the ring's
// assertions, because those pass whatever the spinner does: a spinner switched to
// the sky accent would not move one of them (L63).
const cueLine = r("--cue-line");
const cueLineOnAccent = r("--focus-ring-line-on-accent");
const cueLineDark = rDark("--cue-line");

for (const [name, surface] of [
  ["page beige", r("--bg")],
  ["hover and zebra tint", r("--bg-alt")],
  ["card surface", r("--surface")],
  ["elevated surface", r("--surface-elevated")],
  ["the sidebar current item's sky wash", r("--pennie-sky-soft")],
] as [string, RGB][]) {
  atLeast(cueLine, surface, 3, `spinner arc on ${name} (light)`);
}
for (const [name, surface] of [
  ["a sky fill", sky],
  ["a sky fill on hover", skyHover],
  ["a pressed sky fill", skyDeep],
] as [string, RGB][]) {
  atLeast(cueLineOnAccent, surface, 3, `spinner arc on ${name} (either theme)`);
}
for (const [name, surface] of [
  ["the navy page", rDark("--bg")],
  ["a dark hover tint", rDark("--bg-alt")],
  ["a dark card", rDark("--surface")],
  ["a dark elevated surface", rDark("--surface-elevated")],
] as [string, RGB][]) {
  atLeast(cueLineDark, surface, 3, `spinner arc on ${name} (dark)`);
}

// The positive controls for that block. Sky is the colour anybody would reach for
// (it is THE action colour), and it is the one that cannot be used, so each way it
// fails is held as a tripwire or the assertions above are passing unexamined.
below(sky, r("--pennie-sky-soft"), 3, "sky arc on the sidebar's current-item wash - why the cue is not the accent");
below(sky, beige, 3, "sky arc on the beige page - the same failure on an ordinary surface");
below(sky, sky, 3, "sky arc on a sky button - the cue would be completely invisible");

// --- D17: forbidden-as-text tripwires — must STAY failing -------------------
// (an accidental palette shift that "fixes" one of these is a regression signal)
below(graphite, skyDeep, 4.5, "graphite-on-sky-deep - must NOT be a CTA text bg (4.32 fail)");
below(sky, beige, 4.5, "sky as text on beige - forbidden");
below(white, sky, 4.5, "white text on sky - forbidden");

// --- Supplemental (Phase 3 sweep / 2.3): Pill pairings + dark error ---------
const greenWash = r("--pennie-green-wash");
const ink2 = r("--pennie-ink-2");
const roseDark = rDark("--error"); // lightened rose in the dark flip (2.3)
atLeast(graphite, greenWash, 4.5, "Pill status-ok graphite-on-green-wash"); // 11.58
atLeast(rose, white, 4.5, "Pill status-error rose-on-white"); // 5.14
atLeast(roseDark, ink2, 4.5, "dark error rose-on-ink-2 surface"); // 4.96
atLeast(roseDark, navy, 4.5, "dark error rose-on-navy bg"); // 6.72

// --- #1124: the erasure worklist's success panel ----------------------------
// Both halves are RAW tokens, so this pair does not move between themes and needs
// no dark override. It is asserted here because it is a filled panel carrying a
// sentence, which is the case the sky family is easiest to get wrong in (sky
// itself fails as text on light, and white fails on sky).
const skySoft = r("--pennie-sky-soft");
atLeast(graphite, skySoft, 4.5, "erasure purge result graphite-on-sky-soft");

// #1054: a transparent Pill on a band that paints its OWN dark fill.
//
// Found by an axe run, not by this guard, and that is the lesson in it. The pills in
// the agent detail page's navy identity band drew their label in `--fg`, which follows
// the PAGE theme, so the light theme put graphite on navy at 1.28:1: an invisible pill,
// not a low-contrast one. This guard could not have caught it, because it checks token
// PAIRINGS and that was a call site composing two individually correct tokens (L213).
//
// What it CAN do is hold the pairing the fix introduced, so `Pill`'s `onDark` treatment
// cannot drift below the line. Both halves are raw tokens, so it does not move between
// themes.
atLeast(beige, navy, 4.5, "Pill onDark beige-on-navy (the #1054 fix)");
// And the pairing that was broken must STAY broken, so nobody reintroduces it believing
// it passes. A guard that only asserts the good pair says nothing about the bad one.
below(graphite, navy, 4.5, "graphite-on-navy is NOT a legible pill label (1.28 fail)");

finish();
