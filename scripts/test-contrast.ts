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

function atLeast(fg: RGB, bg: RGB, min: number, label: string) {
  const v = ratio(fg, bg);
  if (v + 1e-9 >= min) assert(`${label} = ${v.toFixed(2)}:1 (>= ${min})`);
  else fail(`${label} = ${v.toFixed(2)}:1 (needs >= ${min})`);
}
function below(fg: RGB, bg: RGB, max: number, label: string) {
  const v = ratio(fg, bg);
  if (v < max) assert(`${label} = ${v.toFixed(2)}:1 (correctly < ${max}, forbidden as text)`);
  else fail(`${label} = ${v.toFixed(2)}:1 (expected < ${max} - token may have changed)`);
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

// --- D17: focus indicators must PASS 3:1 (1.4.11 non-text) ------------------
atLeast(graphite, beige, 3, "focus line graphite-on-beige (light theme)");
atLeast(sky, navy, 3, "focus line sky-on-navy (dark theme)");

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

finish();
