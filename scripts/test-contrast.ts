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
import { ratio, type RGB } from "./lib/wcag-contrast.ts";
import {
  parseColourClass,
  scanRosePairings,
  tokenForColourClass,
  type ClassPair,
  type Theme,
} from "./lib/scan-rose-pairings.ts";
import { sourceFiles } from "./lib/source-files.ts";
import { WARNING_NOTICE_CLASS } from "../src/components/ui/warning-notice-paint.ts";

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

// WCAG luminance and ratio live in scripts/lib/wcag-contrast.ts, shared with
// the guards that verify the numbers quoted in DESIGN.md and the design records.

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

// --- #2660: the test mode marker, DESIGN.md's Test Mode Rule -----------------
//
// One paint in both themes, deliberately, like the hazard stripe: the sentence
// is graphite on mint, which does not depend on the page behind it. What DOES
// depend on the page is whether the band reads as a band at all, and that is
// carried by a different part in each theme: the band's graphite chip (the
// word on the band) against a light card, and the mint fill itself against a
// dark one. The band had a graphite left edge as well until 2026-10-06, removed
// because the card's rounded corner clipped it into a stray line. Both halves measured, and
// the pair asserted in both themes, so a token edit cannot leave the tester's
// sentence unreadable on the embed's dark theme.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  atLeast(read("--test-mode-fg"), read("--test-mode-bg"), 4.5, `test mode sentence on its band (${theme})`);
  const chip = ratio(read("--test-mode-fg"), read("--surface"));
  const fill = ratio(read("--test-mode-bg"), read("--surface"));
  assert(
    Math.max(chip, fill) + 1e-9 >= 3,
    `the test mode band is told from the card behind it (${theme}): chip ${chip.toFixed(2)}:1, fill ${fill.toFixed(2)}:1, one of them >= 3`,
  );
}

// --- #3549: the warning notice, rose outline on a rose wash ------------------
//
// Dan's call on 2026-10-08, from a rendered round: the sentence is ROSE on light
// and the theme's own text on dark, inside a rose outline over a faint rose
// wash. Rose text on a rose wash is the tight pair (the booker records 4.33:1 at
// a 12% wash, an AA fail), so the wash is read out of the class that ships rather
// than written here, and a heavier wash fails this rather than the sentence.
{
  const m = /var\(--error\)_(\d+)%/.exec(WARNING_NOTICE_CLASS);
  assert(m !== null, "the warning notice's wash percentage is readable from its class");
  const pct = m ? Number(m[1]) / 100 : 1;
  const wash = (over: RGB, tint: RGB): RGB =>
    over.map((c, i) => Math.round(tint[i] * pct + c * (1 - pct))) as RGB;
  // The wash is mixed into the CARD colour rather than into transparent, so the
  // notice paints its own background and measures the same on a card or on the
  // page. Over transparent, the rose sentence on the beige page is 4.39:1.
  assert(/var\(--error\)_\d+%,var\(--surface\)\)/.test(WARNING_NOTICE_CLASS), "the warning paints its own background, not whatever is behind it");
  assert(/\btext-\[var\(--error\)\]/.test(WARNING_NOTICE_CLASS), "the warning sentence is rose on light");
  assert(/\bdark:text-fg\b/.test(WARNING_NOTICE_CLASS), "the warning sentence is the theme's own text on dark");
  const lightWash = wash(r("--surface"), r("--error"));
  const darkWash = wash(rDark("--surface"), rDark("--error"));
  atLeast(r("--error"), lightWash, 4.5, "warning sentence, rose on its rose wash (light)");
  atLeast(rDark("--fg"), darkWash, 4.5, "warning sentence, fg on its rose wash (dark)");
  atLeast(rDark("--error"), darkWash, 3, "warning icon, rose on its rose wash (dark)");
  atLeast(r("--error"), r("--surface"), 3, "warning outline against the card (light)");
  atLeast(rDark("--error"), rDark("--surface"), 3, "warning outline against the card (dark)");
}

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

// --- #1830 / #1832: the tier ledger's two letter tones ---------------------
//
// Five letters in fixed positions, one per rung, all uppercase, separated by
// WEIGHT and TONE.
//
// THE 3:1 FLOOR THAT USED TO BE HERE WAS BUILT ON A PREMISE THAT IS FALSE, and
// this block is its replacement. The claim was that the uncovered letters
// identified their own slots, so a reader could tell one pattern from another
// without counting, which made them functional marks owing 3:1. They do not. The
// COVERED letters are their own labels: three dark letters reading M H V
// say Medium, High, Very High directly, and a lone dark L says Low. Nothing is
// ever counted. What the faint ones carry is the five slot rhythm, so rows align
// and the cell width never varies, plus a sense of the scale's extent. That needs
// them PERCEPTIBLE, not legible.
//
// So three real requirements replace the invented one.
const ledgerOn = r("--ledger-on");
const ledgerOff = r("--ledger-off");
const ledgerOnDark = rDark("--ledger-on");
const ledgerOffDark = rDark("--ledger-off");

/** Every surface a roster row is drawn on. The zebra tint is the tightest. */
const LEDGER_SURFACES_LIGHT: [string, RGB][] = [
  ["the card", r("--surface")],
  ["a zebra row", r("--bg-alt")],
  ["the page", r("--bg")],
];
const LEDGER_SURFACES_DARK: [string, RGB][] = [
  ["a dark card", rDark("--surface")],
  ["a zebra dark row", rDark("--bg-alt")],
  ["the dark page", rDark("--bg")],
];

// ONE. The covered letters carry the meaning, so they keep the text floor
// exactly as it was.
for (const [name, surface] of LEDGER_SURFACES_LIGHT) {
  atLeast(ledgerOn, surface, 4.5, `ledger covered letter on ${name} (light)`);
}
for (const [name, surface] of LEDGER_SURFACES_DARK) {
  atLeast(ledgerOnDark, surface, 4.5, `ledger covered letter on ${name} (dark)`);
}

// TWO. The uncovered letters stay PERCEPTIBLE, so they cannot be lightened until
// the slot rhythm disappears. THIS IS A PERCEPTIBILITY FLOOR, NOT A WCAG ONE:
// these letters carry no meaning a reader has to extract, so 3:1 does not apply
// and putting it back would be a correction in the wrong direction. Set against
// the ZEBRA row, which is the tightest surface in both themes and the one an
// eyeballed value misses, with headroom below the shipped 1.74 and 1.59.
const PERCEPTIBLE = 1.4;
for (const [name, surface] of LEDGER_SURFACES_LIGHT) {
  atLeast(ledgerOff, surface, PERCEPTIBLE, `ledger uncovered letter still visible on ${name} (light)`);
}
for (const [name, surface] of LEDGER_SURFACES_DARK) {
  atLeast(ledgerOffDark, surface, PERCEPTIBLE, `ledger uncovered letter still visible on ${name} (dark)`);
}

// THREE. The two states have to read as two states, which is the quantity that
// actually matters and which no per-surface floor checks: both could clear their
// floors and be the same colour.
//
// ASSERTED PER THEME, AND THE ASYMMETRY IS ASSERTED TOO. The two themes take
// different tones on purpose: light text on a dark ground blooms, so a pale
// letter on dark carries more presence than the same ratio does the other way
// round, and holding both sides to one figure produces two different-looking
// treatments. Two hand-picked values where one derived value would apparently do
// is exactly what somebody consolidates, and doing so would silently reverse a
// deliberate decision while reading as a tidy-up (L542). So a unified value FAILS
// the last line here rather than passing quietly. Confirmed by looking at 12px,
// not by arithmetic; there is precedent in --focus-ring-line, which is a
// different HUE per theme for the same kind of reason.
const TWO_STATES = 4.5;
atLeast(ledgerOn, ledgerOff, TWO_STATES, "ledger: covered against uncovered (light)");
atLeast(ledgerOnDark, ledgerOffDark, TWO_STATES, "ledger: covered against uncovered (dark)");
{
  const gapLight = ratio(ledgerOn, ledgerOff);
  const gapDark = ratio(ledgerOnDark, ledgerOffDark);
  const said = `ledger: the light gap (${gapLight.toFixed(2)}) is wider than the dark one (${gapDark.toFixed(2)})`;
  if (gapLight > gapDark + 0.5) assert(true, `${said}, which is the deliberate asymmetry`);
  else fail(`${said}, so the two themes have been collapsed to one figure; see the note above`);
}

// The tones that must never be used here, kept as tripwires so the reasons stay
// measured. Mercury is what DESIGN.md nominates for the unfilled half of a meter
// and it is far too faint even for a perceptibility floor.
below(r("--pennie-mercury"), r("--surface"), PERCEPTIBLE, "mercury as a ledger letter on a card - the 1.28:1 the mockup used");
below(r("--pennie-line"), r("--bg"), PERCEPTIBLE, "the stroke tone as a ledger letter on the page");
// Body text as the uncovered tone is the OTHER direction of failure: perfectly
// visible, and so close to the covered letters that the two stop reading as two
// states. That is what shipped before #1832 and what the gap floor now refuses.
below(r("--fg-muted"), ledgerOn, TWO_STATES, "body text as the uncovered tone - too close to the covered letters");
// #1958 CONSUMED THE OLD FORM OF THIS ONE, and it is worth saying why rather
// than editing the number. It read `below(rDark("--fg-muted"), rDark("--fg"), 2)`
// and its stated reason was "1.00:1 from the foreground, so no tone step at all".
// That was true, and it was a symptom of the dark theme having no muted text
// colour at all rather than a fact about the ledger, so the assertion was
// recording a defect while reading as a design decision (L373).
//
// Dark muted is 2.32:1 from the foreground now, and it STILL must not be the
// quiet letter, for the durable reason: it does not give the two state gap from
// the covered letters. That is the same reason the light theme's line above
// gives, so the two themes now refuse it for one reason instead of two.
below(
  rDark("--fg-muted"),
  rDark("--ledger-on"),
  TWO_STATES,
  "the dark theme's own muted text as the quiet letter - no two state gap from the covered letters",
);

// --- #1822: which semantic colours may be a BARE MARK ----------------------
//
// A mark that carries meaning with no text beside it needs 3:1 (WCAG 2.1 SC
// 1.4.11): a status dot, a meter fill, a mark in a chart. DESIGN.md nominated
// green for "a healthy or bookable state" and said nothing about the fact that no
// green in the palette could carry that meaning on its own. Nothing had caught it
// because every existing green use is a WASH behind dark text, where a word does
// the work.
//
// The record read as permission, which is how the 25 focus rings shipped at
// 1.57:1 (#1768): somebody reaches for the colour the file nominates, gets a mark
// nobody can see, and nothing fails. So the reason each colour is or is not
// available is recorded here as a measurement rather than as a sentence somebody
// can disagree with.
const greenMark = r("--pennie-green-mark");
const wash = r("--pennie-green-wash");

// The new green, on every LIGHT surface a mark lands on, plus the wash it sits on
// inside a status pill.
for (const [name, surface] of [
  ["a white card", r("--surface")],
  ["the beige page", r("--bg")],
  ["a hovered row", r("--bg-alt")],
  ["the green wash inside a status pill", wash],
] as [string, RGB][]) {
  atLeast(greenMark, surface, 3, `green mark on ${name}`);
}

// ITS LIMIT WAS REMOVED BY #1958, and this is recorded as a re-measurement
// rather than as a nudged threshold, because a threshold moved to keep a suite
// green is how an assertion starts passing for a reason nobody has checked.
//
// The green mark used to read 2.68:1 on the dark theme's row tint, so it was
// scoped to light surfaces plus the wash. #1958 brought the whole dark surface
// ladder down to make a muted text colour legible, and every mark on dark gained
// contrast as a side effect: the green mark now clears 3:1 on all five dark
// surfaces, the tightest being the elevated one at 3.23:1.
//
// So the prohibition is gone. It is not replaced by permission to use green
// anywhere: the wash remains the case a status dot is designed for, and green
// still cannot be a bare mark in LIGHT theme's palette forms above. What changed
// is one measured fact, and it is asserted in the direction it now runs so the
// suite cannot go on defending a limit that no longer exists.
for (const [name, surface] of [
  ["the dark page", rDark("--bg")],
  ["a dark input well", rDark("--field")],
  ["a dark card", rDark("--surface")],
  ["a hovered dark row", rDark("--bg-alt")],
  ["a dark elevated surface", rDark("--surface-elevated")],
] as [string, RGB][]) {
  atLeast(greenMark, surface, 3, `green mark on ${name} (dark, freed by #1958)`);
}

// Neither existing green can be a bare mark. Held as tripwires, so the reason the
// palette green is unavailable stays a measurement.
for (const [label, token] of [
  ["the palette green", "--pennie-green"],
  ["the deepest green", "--pennie-green-deep"],
] as [string, string][]) {
  below(r(token), r("--surface"), 3, `${label} as a bare mark on a white card`);
  below(r(token), r("--bg"), 3, `${label} as a bare mark on the beige page`);
  below(r(token), wash, 3, `${label} as a bare mark on the green wash`);
}

// The other two semantic colours, asked the same question rather than left to be
// discovered the same way.
//
// ROSE IS LEGAL as a bare mark, in both themes, which is worth recording because
// it is the one nobody would have guessed: the dark theme lightens it, so both
// halves of the flip clear.
for (const [name, surface] of [
  ["a white card", r("--surface")],
  ["the beige page", r("--bg")],
  ["a hovered row", r("--bg-alt")],
] as [string, RGB][]) {
  atLeast(rose, surface, 3, `rose as a bare mark on ${name} (light)`);
}
for (const [name, surface] of [
  ["a dark card", rDark("--surface")],
  ["a hovered dark row", rDark("--bg-alt")],
] as [string, RGB][]) {
  atLeast(rDark("--error"), surface, 3, `rose as a bare mark on ${name} (dark)`);
}

// YELLOW CANNOT, on light, by a wide margin. It has to work in both themes to be
// usable, so it is illustration only and that is now measured.
below(r("--pennie-yellow"), r("--surface"), 3, "yellow as a bare mark on a white card");
below(r("--pennie-yellow"), r("--bg"), 3, "yellow as a bare mark on the beige page");

// --- #1823: the two marks inside the Bookable pill -------------------------
//
// Named for THIS use rather than left to the bare-mark block above, because
// those assertions pass whatever the pill does (L63). The two marks also differ
// in SHAPE, a filled disc against a ring, so neither of these is carrying the
// distinction alone.
atLeast(
  r("--pennie-green-mark"),
  r("--pennie-green-wash"),
  3,
  "bookable Yes: the filled dot on the pill's own green wash",
);
for (const [name, surface] of [
  ["a white card", r("--surface")],
  ["a hovered row", r("--bg-alt")],
] as [string, RGB][]) {
  atLeast(r("--fg-muted"), surface, 3, `bookable No: the hollow ring on ${name} (light)`);
}
for (const [name, surface] of [
  ["a dark card", rDark("--surface")],
  ["a hovered dark row", rDark("--bg-alt")],
] as [string, RGB][]) {
  atLeast(rDark("--fg-muted"), surface, 3, `bookable No: the hollow ring on ${name} (dark)`);
}

// --- #3030: the DASHED ring, for an advisor Twilio holds back --------------
//
// Measured from the token the pill's source actually draws the ring with, not
// from a name typed here, so a later change to the ring's colour is measured
// rather than passed over (L63). The dashed ring and the solid one share that
// token by construction (one RING class, dashed for Redistribute), and both are
// asserted here: the word carries the meaning, and the mark has to be visible
// wherever the pill sits, which for the agent's own page is the beige page too.
{
  const pillSrc = readFileSync(join("src", "components", "ui", "BookablePill.tsx"), "utf8");
  const ringLine = pillSrc.match(/const RING = "([^"]+)"/);
  assert(ringLine != null, "BookablePill declares one RING class for both rings");
  const ringToken = ringLine?.[1].match(/border-\[var\((--[\w-]+)\)\]/)?.[1];
  assert(ringToken != null, `the ring's colour token is readable from BookablePill (${ringToken})`);
  assert(
    /redistribute:\s*\{\s*name:\s*"dashed",\s*className:\s*`\$\{RING\} border-dashed`/.test(pillSrc),
    "the Redistribute mark is the same RING, dashed",
  );
  if (ringToken) {
    for (const [name, surface] of [
      ["a white card", r("--surface")],
      ["the beige page", r("--bg")],
      ["a hovered row", r("--bg-alt")],
    ] as [string, RGB][]) {
      atLeast(r(ringToken), surface, 3, `bookable Redistribute: the dashed ring on ${name} (light)`);
    }
    for (const [name, surface] of [
      ["a dark card", rDark("--surface")],
      ["the dark page", rDark("--bg")],
      ["a hovered dark row", rDark("--bg-alt")],
    ] as [string, RGB][]) {
      atLeast(rDark(ringToken), surface, 3, `bookable Redistribute: the dashed ring on ${name} (dark)`);
    }
  }
}

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

// #1997: THE SAVE CONFIRMATION SITS ON THAT SAME WASH, and it is asserted by its
// own name rather than left to the pill's assertion above (L63: assert the
// quantity you exist to protect, not a proxy for it).
//
// It drew `text-fg` on the wash. The wash is a RAW token and is the same pale
// green in both themes, deliberately, so that "this went well" does not change
// colour; `--fg` is not raw and is a near white in dark. The result was near
// white on pale green: present in the DOM, correctly announced, and invisible on
// screen (L213). Every save confirmation on every admin page had it.
//
// The forbidden pairing is held below as the record of the defect, because that
// is what tells the next person why the panel does not use `--fg` like almost
// everything else does.
atLeast(graphite, greenWash, 4.5, "the save confirmation's text on its own green wash");
below(
  rDark("--fg"),
  greenWash,
  4.5,
  "dark's foreground on the green wash - why the save confirmation pins graphite",
);

// AND THE CALL SITE IS READ, because the two assertions above cannot see it.
//
// This file checks token PAIRINGS. The defect was a call site composing two
// individually correct tokens, which is exactly the gap named further down about
// the navy Pill: reverting the component to `text-fg` leaves every pairing
// assertion here passing. So the panel's own class string is read.
//
// The rule is about the KIND of token, not the exact value: anything painting a
// RAW background (one that is the same in both themes on purpose) must pin a raw
// foreground too, because a theme-flipping one is only correct in the theme
// somebody happened to look at.
{
  const src = readFileSync(join("src", "app", "admin", "settings", "SettingsSaveNotice.tsx"), "utf8");
  const onWash = src
    .split("\n")
    .filter((l) => l.includes("--pennie-green-wash"));
  assert(onWash.length > 0, "the save confirmation still paints the green wash");
  for (const line of onWash) {
    assert(
      /text-pennie-[\w-]+/.test(line),
      `the text on the green wash is a raw token, not one that flips: ${line.trim()}`,
    );
    assert(
      !/\btext-fg\b/.test(line),
      `the text on the green wash is not --fg, which is a near white in dark: ${line.trim()}`,
    );
  }
}
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
// The `onDark` prop that fixed it is GONE (#1838): every page header is an ordinary
// card now, so it had no call sites left, and the navy surfaces that remain (the login
// brand panel, the impersonation banner and its dropped session notice, the time off
// stat grid) render no Pill at all.
//
// These two assertions stay, and the second is the one that matters. The forbidden
// pairing is the RECORD of the defect, and it outlives the remedy: it is what tells
// somebody putting a pill on one of those navy surfaces that the label they are about
// to inherit is invisible there. A guard that only asserted the good pair would have
// been deleted with the prop and taken the knowledge with it.
atLeast(beige, navy, 4.5, "cream on navy is the pairing a label on a navy surface needs");
below(graphite, navy, 4.5, "graphite-on-navy is NOT a legible pill label (1.28 fail)");

// #1838: the page header is a card, so its title and description are ordinary
// foreground tokens on an ordinary surface. Held here because the whole risk in that
// change was leaving a foreground chosen for a dark ground on a light card, which is
// invisible rather than merely low contrast.
atLeast(graphite, white, 4.5, "page header title, graphite on the card surface");
atLeast(muted, white, 4.5, "page header description, muted on the card surface");

// ============================================================================
// A SURFACE MEASURED AGAINST THE SURFACE IT SITS ON (#1851)
// ============================================================================
//
// Everything above asks whether TEXT is legible on a surface. Nothing asked
// whether the surface is distinguishable from the one behind it, and that gap is
// how `--bg-alt` shipped at 1.009:1 against the page under a fully green suite.
//
// One point of difference per channel is not low contrast, it is no colour
// change: the hover tint tinted nothing, the zebra rows did not stripe, and the
// table header on /admin/tiers was not a header row. The suite covered the token
// at ten sites and passed every one, because all ten treated it as a BACKGROUND
// and asked about the text on it, which was true and was never the question
// (L63: assert the quantity you exist to protect, not a proxy for it).
//
// THE FLOOR IS NOT `PERCEPTIBLE` (1.4), AND THAT IS MEASURED RATHER THAN
// PREFERRED. On a near-white page a tint cannot reach 1.4 and still carry body
// copy: the value that hits it is around rgb(210, 206, 198), on which
// `--fg-muted` falls to about 3.5:1 and breaks AA for the text these surfaces
// exist to hold. The usable band in light mode runs from 1.00 to about 1.09,
// where rgb(238, 234, 226) already puts muted text at 4.48 and under the line.
// So the floor sits inside the achievable band, and the ceiling is recorded here
// so the next person does not spend the same hour rediscovering it.
//
// The value was chosen by RENDERING the candidates as zebra rows and a header
// row rather than by picking a number: at today's value the stripes are not
// there at all, and at `--pennie-cream-3` they read immediately. Dark mode was
// already given a real value and clears this comfortably at 1.48 (it read 1.88
// until #1958 brought the dark ladder down to make a muted text colour legible;
// the figure is restated rather than left as prose the passing check does not
// verify, L210).
const SURFACE_SEPARATION = 1.05;

for (const [label, over, under] of [
  ["light hover and zebra tint against the page", r("--bg-alt"), r("--bg")],
  ["dark hover and zebra tint against the page", rDark("--bg-alt"), rDark("--bg")],
  ["dark card against the page", rDark("--surface"), rDark("--bg")],
] as [string, RGB, RGB][]) {
  atLeast(over, under, SURFACE_SEPARATION, label);
}

// THE TWO EXEMPTIONS, each with the reason it is exempt rather than simply
// missing from the list above (L233).
//
// A light card is white on beige at 1.08, which clears this, but it would not
// need to: `cardCls` gives it `shadow-xs` in light and a border in dark, so its
// edge is drawn rather than implied. It is left out because a shadow is what
// separates it, and a rule demanding a fill difference would be asserting
// something the design does not rely on.
//
// `--surface-elevated` is the same colour as `--surface` in light on purpose,
// so any separation rule would fail it by construction. In dark the two really
// do differ, and that IS asserted, because there the token means something.
atLeast(rDark("--surface-elevated"), rDark("--surface"), 1.2, "dark elevated surface against a card");

// The text that has to survive the tint being darker. Making a background darker
// is the failure this change can cause, so these are the assertions that catch
// it: they are stated here as well as above, because these are the ones that
// bound how far the tint may go.
atLeast(r("--fg"), r("--bg-alt"), 4.5, "body text on the light hover and zebra tint");
atLeast(r("--fg-muted"), r("--bg-alt"), 4.5, "muted text on the light hover and zebra tint");

// --- #1875: the destructive button (.pn-btn--danger) ------------------------
// An outline, not a rose fill, because a fill needs its foreground to FLIP with
// the theme and a pair whose halves are maintained apart is the one that breaks
// silently (L213). Both halves are asserted: the label as text at 4.5, and the
// border as an interface component at 3, in each theme. The dark theme is the
// half that would be missed, since the light rose is the value a light-only check
// would never reach.
const surfaceLight = r("--surface");
const surfaceDarkCard = rDark("--surface");
atLeast(rose, surfaceLight, 4.5, "danger button label on a light card"); // 5.14
atLeast(rose, surfaceLight, 3, "danger button border on a light card");
atLeast(roseDark, surfaceDarkCard, 4.5, "danger button label on a dark card"); // 4.91
atLeast(roseDark, surfaceDarkCard, 3, "danger button border on a dark card");

// ============================================================================
// THE DESTRUCTIVE CONFIRM, INCLUDING THE STATE A POINTER IS IN (#2455)
// ============================================================================
//
// Everything above measures the danger button AT REST. Its hover was a 12% rose
// wash, and a wash is TRANSLUCENT, so what the label ended up on was whatever sat
// behind the button and nothing measured any of it. Two surfaces, two answers,
// both under AA, in the state a mouse user is in at the moment of pressing:
//
//   rose label on a 12% rose wash over a white card    4.33:1
//   the same label on the same wash over the page      4.03:1
//
// The two hand rolled confirms stacked a second wash under that one and got
// 4.17:1 and 3.89:1, which is the 3.79:1 axe measured on the live page.
//
// The composite is what the tripwires below record, so a wash cannot come back
// wearing a different alpha.
function composite(over_: RGB, alpha: number, under: RGB): RGB {
  return [0, 1, 2].map((i) => over_[i] * alpha + under[i] * (1 - alpha)) as RGB;
}

// ONE. The hover is an OPAQUE fill now, so it has one value wherever it lands and
// can be measured once. Its foreground FLIPS with the theme, which is the pair
// shape that goes wrong silently (L213), so both halves are read in both themes
// and the wrong half is held below as a tripwire.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  const fill = read("--error");
  atLeast(read("--fg-on-error"), fill, 4.5, `danger button label on its own hover fill (${theme})`);
  for (const surface of ["--field", "--surface", "--bg"]) {
    atLeast(fill, read(surface), 3, `danger button hover fill against ${surface} (${theme})`);
  }
}

// TWO. The rest state, on the ground the shared confirm panel actually paints.
// `--field` rather than a rose wash, and that is the whole finding: the panel is
// neutral so this number is true wherever the panel lands.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  const label = read("--error");
  atLeast(label, read("--field"), 4.5, `destructive confirm label on the panel (${theme})`);
  atLeast(label, read("--field"), 3, `destructive confirm border on the panel (${theme})`);
  // The panel's own rose edge, against both surfaces it can sit on: the agent's
  // list is drawn straight on the page and the manager's queue is inside a card,
  // which is exactly why the same class string measured two different ways.
  for (const behind of ["--bg", "--surface"]) {
    atLeast(read("--error"), read(behind), 3, `the confirm panel's rose edge against ${behind} (${theme})`);
  }
}

// THREE. The tripwires. Each is a treatment somebody would reasonably reach for,
// and each must STAY failing or the assertions above are passing unexamined.
below(
  rose,
  composite(rose, 0.1, composite(rose, 0.05, r("--bg"))),
  4.5,
  "the hand rolled confirm on the agent's page - the 3.89 this issue was opened about",
);
below(
  rose,
  composite(rose, 0.1, composite(rose, 0.05, r("--surface"))),
  4.5,
  "the same class string on the manager's card - the same defect measuring 4.17",
);
below(
  rose,
  composite(rose, 0.12, r("--surface")),
  4.5,
  "the old hover wash on a card - why the hover is an opaque fill",
);
below(
  rose,
  composite(rose, 0.12, r("--bg")),
  4.5,
  "the old hover wash on the page - the same wash, a worse number, nothing measuring either",
);
// The wash pale enough to keep a rose label at 4.5:1 is not a surface at all, so
// there is no alpha that satisfies both. This is the measurement that says the
// panel had to go neutral rather than get a lighter tint.
below(
  composite(rose, 0.08, white),
  r("--bg"),
  1.05,
  "the palest rose wash a rose label survives, against the page - no separation, so no wash works",
);
// And the foreground that must not be shared between the themes. Each theme's
// value is the other theme's failure, which is why `--fg-on-error` exists.
below(white, roseDark, 4.5, "light's label on the dark rose fill - 2.39, an invisible label");
below(graphite, rose, 4.5, "dark's label on the light rose fill - 2.42, the same failure the other way");

// FOUR. And the CSS really declares that pair, read out of the rule rather than
// restated here, so these numbers cannot go on passing about a button that has
// gone back to painting a wash (L63).
{
  const hover = CSS.match(/\.pn-btn--danger:hover\s*\{([\s\S]*?)\}/);
  assert(hover !== null, ".pn-btn--danger declares a hover state");
  const decl = hover?.[1] ?? "";
  assert(
    /background:\s*var\(--error\)/.test(decl),
    "the danger button's hover background is the opaque rose, not a wash",
  );
  assert(
    /color:\s*var\(--fg-on-error\)/.test(decl),
    "and it repaints the label with the foreground measured against that fill",
  );
  assert(
    !/--error-bg/.test(CSS),
    "the translucent rose wash token is gone rather than left beside its replacement",
  );
}

// --- #1881: the header tab's pending count -----------------------------------
//
// The pair is READ OUT OF THE COMPONENT'S OWN CLASSES rather than restated here,
// so this cannot pass while the badge renders something else (L63). That is the
// whole point: the sky wash was already covered by four assertions in this file,
// every one of them measuring something drawn ON TOP of it, and none asking
// whether the wash was visible against what was behind it. It was not: 1.00:1 on
// the beige header.
//
// Both halves, in both themes. The FILL is an interface component, so 3:1, and it
// is measured against `--bg`, which is what the header paints. The LABEL is small
// text, so 4.5:1 on the fill.
const STYLES_FILE = join("src", "components", "ui", "styles.ts");
const stylesSrc = readFileSync(STYLES_FILE, "utf8");

/** `bg-pennie-blue` -> `--pennie-blue`, `text-white` -> `--pennie-white`. */
function tokenForClass(cls: string): string {
  const bare = cls.replace(/^(bg|text)-/, "");
  return bare === "white" ? "--pennie-white" : `--${bare}`;
}

/**
 * The one COLOUR class the badge declares for this prefix.
 *
 * Every `text-` class is collected and then filtered to the ones naming a real
 * token, because `text-xs` matches the prefix just as well as
 * `text-pennie-blue`: taking the first match read the font size as a colour and
 * failed on a token called `--xs`. Several matches is its own refusal rather
 * than a first-one-wins guess (L521), so a second colour added to the constant
 * fails the build instead of being silently ignored.
 */
function badgeClass(prefix: "bg" | "text"): string {
  const decl = stylesSrc.match(/export const badgeCountCls\s*=([\s\S]*?);\n/);
  if (!decl) throw new Error(`badgeCountCls not found in ${STYLES_FILE}`);
  const all = [...decl[1].matchAll(new RegExp(`\\b${prefix}-[\\w-]+`, "g"))].map((m) => m[0]);
  const colours = all.filter((c) => {
    const t = tokenForClass(c);
    return ROOT.has(t) || DARK.has(t);
  });
  if (colours.length === 0) {
    throw new Error(`badgeCountCls declares no ${prefix}- colour class (saw ${all.join(", ")})`);
  }
  if (colours.length > 1) {
    throw new Error(`badgeCountCls declares several ${prefix}- colours: ${colours.join(", ")}`);
  }
  return colours[0];
}

const badgeFill = tokenForClass(badgeClass("bg"));
const badgeLabel = tokenForClass(badgeClass("text"));

for (const [theme, resolve] of [
  ["light", r],
  ["dark", rDark],
] as const) {
  const fill = resolve(badgeFill);
  const label = resolve(badgeLabel);
  const headerBg = resolve("--bg");
  atLeast(fill, headerBg, 3, `pending badge FILL against the ${theme} header (${badgeFill})`);
  atLeast(label, fill, 4.5, `pending badge label on its own fill, ${theme} (${badgeLabel})`);
}

// --- #1958: the muted role, which nothing measured ------------------------
//
// The pair that shipped broken for months, and the reason nothing caught it.
// Dark's `--fg-muted` was mapped to a near white the brand file itself describes
// as footer text on dark, so a hint, a caption, a placeholder and a heading all
// rendered the same colour. Every existing assertion asked whether muted text
// passes against its BACKGROUND, and it passed everywhere with room to spare,
// because the value was brighter than it should be rather than dimmer. The
// direction of failure was the safe looking one.
//
// A muted token only means anything as one half of a pair with PRIMARY (L569),
// and that pair had no assertion in either theme. Both halves are asserted here.

// Half one: muted has to be quieter than primary by a real tone step. A floor
// rather than a figure, so a legitimate refinement of either token is free to
// move it; 1.00 is what shipped, which is no step at all.
const MUTED_STEP = 2;
atLeast(r("--fg"), r("--fg-muted"), MUTED_STEP, "muted text is a tone step below primary (light)");
atLeast(
  rDark("--fg"),
  rDark("--fg-muted"),
  MUTED_STEP,
  "muted text is a tone step below primary (dark)",
);

// Half two: and it still has to be READABLE, on every surface it can land on,
// which is what stops the answer to half one being "make it dimmer". `--bg-alt`
// is the one that bites: it is the tint behind table headers and hovered rows,
// and muted text sits on it all over the admin.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  for (const surface of ["--bg", "--bg-alt", "--surface", "--surface-elevated", "--field"]) {
    atLeast(read("--fg-muted"), read(surface), 4.5, `muted text on ${surface} (${theme})`);
  }
}

// --- #1958: the dark elevation ladder --------------------------------------
//
// Holding both halves above at once is what the ladder change was FOR: a muted
// value dim enough to be a tone step below primary was under 4.5:1 on the two
// brightest dark surfaces, so those surfaces came down.
//
// Two things are asserted about the result, because the ladder is now
// load bearing for the readability of every muted line in the dark admin, and
// neither would fail loudly on its own.
const DARK_LADDER = ["--bg", "--field", "--surface", "--bg-alt", "--surface-elevated"];

// It rises, rung by rung. Nothing checked this before, and the order is the
// whole meaning of the scale: the page recedes, cards float, menus sit highest.
for (let i = 1; i < DARK_LADDER.length; i++) {
  const below_ = rDark(DARK_LADDER[i - 1]);
  const above = rDark(DARK_LADDER[i]);
  const lit = (c: RGB) => ratio(c, [0, 0, 0]);
  const said = `dark ladder: ${DARK_LADDER[i]} sits above ${DARK_LADDER[i - 1]}`;
  if (lit(above) > lit(below_)) assert(true, said);
  else fail(`${said}, but it does not, so the elevation scale is out of order`);
}

// And every rung is a step somebody can SEE. The old ladder's top two rungs were
// 1.05:1 apart, which is one surface wearing two names: a menu did not read as
// floating above a hovered row, and the range the scale spent on that invisible
// step was the range that left no room for a legible muted colour.
//
// This covers the four ADJACENT pairs. `SURFACE_SEPARATION` above covers three
// specific pairs against the page and `dark elevated surface against a card`
// covers one non-adjacent pair at a higher floor; none of them is redundant with
// another, and all of them stay.
const LADDER_STEP = 1.1;
for (let i = 1; i < DARK_LADDER.length; i++) {
  atLeast(
    rDark(DARK_LADDER[i]),
    rDark(DARK_LADDER[i - 1]),
    LADDER_STEP,
    `dark ladder: ${DARK_LADDER[i - 1]} to ${DARK_LADDER[i]} is a visible step`,
  );
}

// --- #2611: every rose pairing written in a class string, in both themes -----
//
// `--fg-on-error` was added for the danger BUTTON's hover (#2455) and measured
// there, while other places went on writing `bg-[var(--error)] text-white` by
// hand: the lead's cancel button and its confirm, the admin cancel and reassign
// confirms, and the calendar sync banner. White is right on the light rose
// (5.14:1) and 2.39:1 on the dark one, so every one of them was unreadable on the
// dark theme while this file reported the pair as passing, because the pair it
// measured was not the pair those sites drew.
//
// So the pairs are FOUND rather than listed: every literal in src that puts a
// text colour on a rose fill, or a rose label on an opaque fill, is resolved to
// its two tokens and measured in both themes. A new site cannot ship unmeasured.
function isColourToken(token: string): boolean {
  try {
    r(token);
    return true;
  } catch {
    return false;
  }
}
// The positive control first: the exact shape this issue was opened about must be
// found and must fail in dark, or the sweep below proves nothing (L1).
{
  const found = scanRosePairings('className="rounded-lg bg-[var(--error)] px-5 text-sm text-white"', isColourToken);
  assert(
    found.length === 1 && found[0].bg === "bg-[var(--error)]" && found[0].fg === "text-white",
    "the rose pairing scan finds a hand written white label on the rose fill",
  );
  below(
    rDark(tokenForColourClass(found[0]?.fg ?? "text-white") ?? "--pennie-white"),
    rDark("--error"),
    4.5,
    "white on the dark rose fill - the 2.39 this issue was opened about",
  );
  assert(
    scanRosePairings('"bg-error/25 text-fg"', isColourToken).length === 0,
    "a translucent rose wash is not measured as an opaque fill (its colour depends on what is behind it)",
  );
  assert(
    scanRosePairings('"text-sm text-center font-semibold"', isColourToken).length === 0,
    "size and alignment classes are not read as colours",
  );
  assert(
    scanRosePairings('"bg-[var(--error)] text-[var(--fg-on-eror)]"', isColourToken).length === 1,
    "a misspelt token in an explicit var() class is kept, so measuring it throws rather than skipping it",
  );
  assert(
    scanRosePairings('"bg-[var(--error)] text-white hover:bg-surface"', isColourToken).length === 1,
    "a hover class is a different state and is not paired with the rest state",
  );
}
const rosePairFiles = sourceFiles({
  match: /\.(ts|tsx)$/,
  exclude: (f) => /\.test\.tsx?$/.test(f),
});
// --- #2836: the same pairs in every INTERACTIVE state, over a real background --
//
// The sweep above measured each rose pair AT REST, and the danger button's hover
// was `hover:opacity-90`, which nobody measured. Opacity fades the label AND the
// fill over whatever is behind the button, so the hovered pair is a composite and
// has a different value on every surface it can land on: white on the rose at 90%
// over a white card read 4.39:1 in light, under AA, at the moment of pressing.
//
// So every state a class string declares (hover, focus, focus-visible, active) is
// resolved to the fill and label it really paints, composited over each surface a
// control can sit on, and measured in both themes. A state that CHANGES the fill
// must also be a visible step from the rest fill, or the hover says nothing.
const STATE_BEHIND = ["--field", "--surface", "--bg"];
const HOVER_STEP = 1.2;
type Measurement = { label: string; value: number; min: number };
// Every ratio a pair's interactive states must clear, returned as data rather
// than asserted, so a fixture can ask WHICH measurement failed and not merely
// whether something did (#2856, L140). Each state is measured only in the themes
// its variant chain applies in: a `dark:hover:` class is a fact about the dark
// theme, and measuring it against the light tokens would both miss its real
// failure and invent a false one.
function stateMeasurements(pair: ClassPair, where: string): Measurement[] {
  const out: Measurement[] = [];
  const reads: Record<Theme, (n: string) => RGB> = { light: r, dark: rDark };
  for (const s of pair.states) {
    const bg = parseColourClass(s.bg);
    const fg = parseColourClass(s.fg);
    // The step is judged against the rest fill of the theme and width the state
    // is in, which a `dark:` or `md:` rest class can change (#2866).
    // Null when the theme has no opaque rest fill; the pair's `unmeasured`
    // then says the step was not judged, and the state's own contrast still is.
    const restBg = s.restBg === null ? null : tokenForColourClass(s.restBg);
    // A state whose colours cannot be resolved FAILS rather than being skipped:
    // a silently skipped state is the blind spot this sweep exists to close (L98).
    if (!bg || !fg || (s.restBg !== null && !restBg)) {
      out.push({ label: `${where} ${s.variant}: cannot resolve ${s.fg} on ${s.bg} to tokens`, value: 0, min: 1 });
      continue;
    }
    for (const theme of s.themes) {
      const read = reads[theme];
      for (const behind of STATE_BEHIND) {
        const ground = read(behind);
        // The fill's own alpha lets the ground through, the label's alpha lets
        // the fill through, and the element's opacity fades both over the ground.
        const solidFill = composite(read(bg.token), bg.alpha, ground);
        const solidLabel = composite(read(fg.token), fg.alpha, solidFill);
        const fill = composite(solidFill, s.opacity, ground);
        const label = composite(solidLabel, s.opacity, ground);
        out.push({
          label: `${where} ${s.variant}: ${s.fg} on ${s.bg} at ${s.opacity} over ${behind} (${theme})`,
          value: ratio(label, fill),
          min: 4.5,
        });
        out.push({ label: `${where} ${s.variant}: ${s.bg} fill against ${behind} (${theme})`, value: ratio(fill, ground), min: 3 });
      }
      // The step from rest is judged on an opaque fill only: a translucent one
      // has a different value on every surface, and the two checks above
      // already measure it against each of them.
      if (restBg !== null && s.bg !== s.restBg && bg.alpha === 1) {
        out.push({
          label: `${where} ${s.variant}: ${s.bg} is a visible step from ${s.restBg} (${theme})`,
          value: ratio(read(bg.token), read(restBg)),
          min: HOVER_STEP,
        });
      }
    }
  }
  return out;
}
// Every ratio a pair's REST paint must clear, per theme and width (#2866). An
// opaque rest pair is the label on the fill, as it always was; a rest opacity
// below 1 fades both over whatever is behind, so it is composited over each
// surface a control can sit on, the same way a state is.
function restMeasurements(pair: ClassPair, where: string): Measurement[] {
  const out: Measurement[] = [];
  const reads: Record<Theme, (n: string) => RGB> = { light: r, dark: rDark };
  for (const p of pair.rest) {
    const bg = tokenForColourClass(p.bg);
    const fg = tokenForColourClass(p.fg);
    if (!bg || !fg) {
      out.push({ label: `${where} ${p.variant}: cannot resolve ${p.fg} on ${p.bg} to tokens`, value: 0, min: 1 });
      continue;
    }
    for (const theme of p.themes) {
      const read = reads[theme];
      if (p.opacity === 1) {
        out.push({ label: `${where} ${p.variant}: ${p.fg} on ${p.bg} (${theme})`, value: ratio(read(fg), read(bg)), min: 4.5 });
        continue;
      }
      for (const behind of STATE_BEHIND) {
        const ground = read(behind);
        out.push({
          label: `${where} ${p.variant}: ${p.fg} on ${p.bg} at ${p.opacity} over ${behind} (${theme})`,
          value: ratio(composite(read(fg), p.opacity, ground), composite(read(bg), p.opacity, ground)),
          min: 4.5,
        });
      }
    }
  }
  return out;
}
/** The themes a pair's rest was actually measured in (a ratio taken, not a refusal). */
function measuredRestThemes(pair: ClassPair, where: string): Set<Theme> {
  const out = new Set<Theme>();
  for (const m of restMeasurements(pair, where)) {
    const theme = m.label.match(/\((light|dark)\)$/)?.[1] as Theme | undefined;
    if (theme) out.add(theme);
  }
  return out;
}
/**
 * The rest guard's expectation for one file: every literal holding an unprefixed
 * opaque fill and an unprefixed opaque label, one of them the rose, keyed
 * `file:line`, with the themes its rest must be measured in.
 *
 * Derived from the literal ALONE, with its own copy of the literal pattern and
 * never through `scanRosePairings`, because a guard whose expectation comes from
 * the scanner can only prove the scanner agrees with itself (L70).
 */
function expectedRestThemes(file: string, src: string): Map<string, Set<Theme>> {
  const out = new Map<string, Set<Theme>>();
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const before = src.slice(0, m.index ?? 0);
    // A comment line quotes a class string rather than painting it.
    if (/^\s*(\/\/|\/\*|\*)/.test(before.slice(before.lastIndexOf("\n") + 1))) continue;
    const classes = m[2].split(/\s+/).filter(Boolean);
    const plain = classes.filter((c) => !c.includes(":"));
    const opaque = (prefix: "bg" | "text") =>
      plain.filter((c) => {
        if (!c.startsWith(`${prefix}-`)) return false;
        const t = tokenForColourClass(c);
        return t !== null && (/^\w+-\[var\(/.test(c) || isColourToken(t));
      });
    const both = [...opaque("bg"), ...opaque("text")];
    if (opaque("bg").length === 0 || opaque("text").length === 0) continue;
    if (!both.some((c) => tokenForColourClass(c) === "--error")) continue;
    // A wash written behind `dark:` alone (`dark:bg-error/20`, `dark:text-x/50`)
    // outranks the unlimited class in the dark theme at every width, so the dark
    // rest there is a translucent paint the scanner deliberately does not
    // measure as a pair. It is not expected, rather than expected and failed.
    // Read from the class text here, never by asking the scanner.
    const darkWash = classes.some((c) => {
      const w = c.match(/^dark:((?:bg|text)-.+?)\/(?:\d+|\[[^\]]+\])$/);
      if (!w) return false;
      const t = tokenForColourClass(w[1]);
      return t !== null && (/^\w+-\[var\(/.test(w[1]) || isColourToken(t));
    });
    out.set(`${file}:${before.split("\n").length}`, new Set<Theme>(darkWash ? ["light"] : ["light", "dark"]));
  }
  return out;
}
/** Every expected `file:line (theme)` the measurement did not reach. */
function restGaps(expected: Map<string, Set<Theme>>, measured: Map<string, Set<Theme>>): string[] {
  const out: string[] = [];
  for (const [at, themes] of expected) {
    for (const theme of themes) if (!measured.get(at)?.has(theme)) out.push(`${at} (${theme})`);
  }
  return out;
}
/** Asserts every rest measurement, and returns the themes it measured a ratio in. */
function measureRest(pair: ClassPair, where: string): Set<Theme> {
  for (const m of restMeasurements(pair, where)) {
    const said = `${m.label} = ${m.value.toFixed(2)}:1`;
    if (m.value + 1e-9 >= m.min) assert(true, `${said} (>= ${m.min})`);
    else fail(`${said} (needs >= ${m.min})`);
  }
  return measuredRestThemes(pair, where);
}
function measureStates(pair: ClassPair, where: string): number {
  for (const m of stateMeasurements(pair, where)) {
    const said = `${m.label} = ${m.value.toFixed(2)}:1`;
    if (m.value + 1e-9 >= m.min) assert(true, `${said} (>= ${m.min})`);
    else fail(`${said} (needs >= ${m.min})`);
  }
  return pair.states.length;
}
/** The labels of every state measurement in a fixture that falls below its floor. */
function failingStates(literal: string): string[] {
  const out: string[] = [];
  for (const pair of scanRosePairings(literal, isColourToken)) {
    for (const m of stateMeasurements(pair, "fixture")) if (m.value + 1e-9 < m.min) out.push(m.label);
  }
  return out;
}
// The positive control: the treatment this issue was opened about must be FOUND
// as a state and must FAIL in light, or the sweep below proves nothing (L1).
{
  const old = scanRosePairings(
    '"bg-[var(--error)] text-[var(--fg-on-error)] transition-opacity hover:opacity-90"',
    isColourToken,
  );
  const st = old[0]?.states ?? [];
  assert(
    st.length === 1 && st[0].state === "hover" && st[0].opacity === 0.9 &&
      st[0].bg === "bg-[var(--error)]" && st[0].fg === "text-[var(--fg-on-error)]",
    "the state scan finds hover:opacity-90 as a hover that keeps the rest pair at 90%",
  );
  below(
    composite(r("--fg-on-error"), 0.9, r("--surface")),
    composite(r("--error"), 0.9, r("--surface")),
    4.5,
    "the old danger hover, white on the rose at 90% over a white card - the 4.39 this issue was opened about",
  );
  const focus = scanRosePairings('"bg-[var(--error)] text-white focus-visible:opacity-80"', isColourToken)[0]?.states ?? [];
  assert(
    focus.length === 1 && focus[0].state === "focus-visible" && focus[0].opacity === 0.8,
    "a focus state is found as well as a hover one",
  );
  const recoloured = scanRosePairings(
    '"bg-[var(--error)] text-white hover:bg-[var(--error-hover)] disabled:opacity-60"',
    isColourToken,
  )[0]?.states ?? [];
  assert(
    recoloured.length === 1 && recoloured[0].bg === "bg-[var(--error-hover)]" &&
      recoloured[0].fg === "text-white" && recoloured[0].opacity === 1,
    "a hover that changes only the fill inherits the rest label, and disabled is not an interactive state",
  );
  assert(
    (scanRosePairings('"bg-[var(--error)] text-white hover:underline"', isColourToken)[0]?.states ?? []).length === 0,
    "a hover that paints no colour or opacity is not a state to measure",
  );
}

// --- #2856: states behind a theme, a breakpoint or a group variant ----------
//
// The state scan above read only a class whose ONE variant was the state, and
// dropped every class carrying a second colon. So `dark:hover:opacity-60`,
// `md:hover:bg-error/60` and `group-hover:opacity-50` were never measured, and a
// rose button could put a translucent hover back behind any of them with this
// file green. Each shape below must be FOUND, placed in the theme it applies in,
// and FAIL on the specific measurement it breaks (L1, L140).
{
  const rest = "bg-[var(--error)] text-[var(--fg-on-error)]";
  const one = (literal: string) => scanRosePairings(literal, isColourToken)[0]?.states ?? [];
  const themesOf = (s: { themes?: string[] } | undefined) => JSON.stringify(s?.themes);

  const dark = one(`"${rest} dark:hover:opacity-60"`);
  assert(
    dark.length === 1 && dark[0].state === "hover" && dark[0].variant === "dark:hover" &&
      dark[0].opacity === 0.6 && themesOf(dark[0]) === '["dark"]',
    "dark:hover:opacity-60 is found as a hover that applies in the dark theme only",
  );
  const darkFails = failingStates(`"${rest} dark:hover:opacity-60"`);
  assert(
    darkFails.some((l) => l.includes(" dark:hover: ") && l.endsWith("(dark)")) &&
      !darkFails.some((l) => l.endsWith("(light)")),
    `dark:hover:opacity-60 fails in dark and is not measured in light (${darkFails.length} failing)`,
  );

  const md = one(`"${rest} md:hover:bg-[var(--error)]/60"`);
  assert(
    md.length === 1 && md[0].state === "hover" && md[0].variant === "md:hover" &&
      md[0].bg === "bg-[var(--error)]/60" && themesOf(md[0]) === '["light","dark"]',
    "md:hover:bg-[var(--error)]/60 is found as a translucent hover fill measured in both themes",
  );
  const mdFails = failingStates(`"${rest} md:hover:bg-[var(--error)]/60"`);
  assert(
    mdFails.some((l) => l.includes(" md:hover: ") && l.includes("on bg-[var(--error)]/60")),
    `md:hover:bg-[var(--error)]/60 fails with its label on the translucent fill (${mdFails.length} failing)`,
  );
  const named = one(`"${rest} md:hover:bg-error/60"`);
  assert(
    named.length === 1 && named[0].bg === "bg-error/60",
    "a named rose token with an alpha (md:hover:bg-error/60) is found as well as an explicit var()",
  );

  const group = one(`"${rest} group-hover:opacity-50"`);
  assert(
    group.length === 1 && group[0].state === "hover" && group[0].variant === "group-hover" &&
      themesOf(group[0]) === '["light","dark"]',
    "group-hover:opacity-50 is found as a hover state in both themes",
  );
  assert(
    failingStates(`"${rest} group-hover:opacity-50"`).some((l) => l.includes(" group-hover: ")),
    "group-hover:opacity-50 fails when measured",
  );

  const combined = one(`"${rest} md:dark:hover:opacity-60"`);
  assert(
    combined.length === 1 && combined[0].variant === "md:dark:hover" && themesOf(combined[0]) === '["dark"]',
    "md:dark:hover:opacity-60 is found as a dark only hover at the md breakpoint",
  );
  assert(
    failingStates(`"${rest} md:dark:hover:opacity-60"`).some((l) => l.includes(" md:dark:hover: ") && l.endsWith("(dark)")),
    "md:dark:hover:opacity-60 fails in dark",
  );

  // A hover recoloured in ONE theme inherits the rest of its paint from the hover
  // that applies in both: the dark hover here is the deeper fill AND 60%.
  const layered = one(`"${rest} hover:bg-[var(--error-hover)] dark:hover:opacity-60"`);
  const darkHover = layered.find((s) => s.themes?.includes("dark"));
  const lightHover = layered.find((s) => s.themes?.includes("light"));
  assert(
    darkHover?.bg === "bg-[var(--error-hover)]" && darkHover.opacity === 0.6 &&
      lightHover?.bg === "bg-[var(--error-hover)]" && lightHover.opacity === 1,
    "a dark hover inherits the fill of the hover that applies in both themes",
  );

  // The negative control: a variant hover that passes must not be flagged, or the
  // controls above are satisfied by a scan that fails every variant it sees.
  const good = `"${rest} dark:hover:bg-[var(--error-hover)] md:hover:bg-[var(--error-hover)] group-hover:bg-[var(--error-hover)]"`;
  const goodFails = failingStates(good);
  assert(
    one(good).length >= 3 && goodFails.length === 0,
    `opaque rose hover steps behind dark, md and group-hover are found and pass (${one(good).length} states, failing: ${goodFails.join("; ") || "none"})`,
  );

  // An unrecognised variant is neither measured nor dropped: it is reported by
  // name so the sweep fails on it, and the next unknown shape is a red build
  // rather than the next blind spot.
  const unknown = scanRosePairings(`"${rest} data-[open]:opacity-50 print:bg-white"`, isColourToken)[0];
  assert(
    unknown?.unrecognised?.join(" ") === "data-[open]:opacity-50 print:bg-white",
    `an unrecognised variant carrying a colour or opacity is reported by name (got ${unknown?.unrecognised?.join(" ")})`,
  );
  assert(
    (scanRosePairings(`"${rest} data-[open]:underline disabled:hover:opacity-50"`, isColourToken)[0]?.unrecognised ?? ["x"]).length === 0,
    "an unrecognised variant painting no colour, and a disabled state, are not reported",
  );
}

// --- #2866: the REST pair behind a theme or breakpoint variant ---------------
//
// #2856 taught the state scan to read `dark:`, breakpoint and `group-` chains,
// while the REST pair was still read from unprefixed classes only. So a rest
// colour or opacity written as `dark:text-white` or `md:bg-white` on a rose
// literal was never measured, and a literal whose rose appeared ONLY behind a
// variant (`bg-surface text-fg hover:bg-[var(--error)]`) was never found as a
// rose pairing at all, taking its hover with it. Each shape below must be FOUND
// and FAIL on the measurement it breaks, beside a counterpart that passes, so a
// scan that fails everything it sees cannot satisfy the controls (L1, L140).
{
  const onRose = "bg-[var(--error)] text-[var(--fg-on-error)]";
  const pairsOf = (literal: string) => scanRosePairings(literal, isColourToken);
  const failing = (literal: string) => {
    const out: string[] = [];
    for (const pair of pairsOf(literal)) {
      for (const m of [...restMeasurements(pair, "fixture"), ...stateMeasurements(pair, "fixture")]) {
        if (m.value + 1e-9 < m.min) out.push(m.label);
      }
    }
    return out;
  };
  const onlyIn = (fails: string[], theme: Theme, needle: string) =>
    fails.some((l) => l.includes(needle) && l.endsWith(`(${theme})`)) &&
    !fails.some((l) => l.endsWith(`(${theme === "dark" ? "light" : "dark"})`));
  const shapes: { name: string; bad: string; theme: Theme | "both"; needle: string; good: string }[] = [
    // White is right on the light rose and 2.39:1 on the dark one.
    { name: "dark:text-white", bad: `${onRose} dark:text-white`, theme: "dark", needle: " dark: text-white on bg-[var(--error)]", good: `bg-[var(--error)] text-white dark:text-[var(--fg-on-error)]` },
    // The dark rose is a light rose, and a rose label on a white card in dark is faint.
    { name: "dark:bg-white", bad: `bg-surface text-[var(--error)] dark:bg-white`, theme: "dark", needle: " dark: text-[var(--error)] on bg-white", good: `${onRose} dark:bg-[var(--error-hover)]` },
    // The rose label on its own fill turns white on white from md up.
    { name: "md:bg-white", bad: `${onRose} md:bg-white`, theme: "light", needle: " md: text-[var(--fg-on-error)] on bg-white", good: `${onRose} md:bg-[var(--error-hover)]` },
    // A rest opacity fades the label and the fill over whatever is behind.
    { name: "dark:opacity-60", bad: `${onRose} dark:opacity-60`, theme: "dark", needle: " dark: text-[var(--fg-on-error)] on bg-[var(--error)] at 0.6", good: `${onRose} dark:opacity-100` },
    // The rose only in the dark rest: found, and the dark label measured on it.
    { name: "dark:bg-[var(--error)] with no other rose", bad: `bg-surface text-fg dark:bg-[var(--error)]`, theme: "dark", needle: " dark: text-fg on bg-[var(--error)]", good: `bg-surface text-fg dark:bg-[var(--error)] dark:text-[var(--fg-on-error)]` },
    // The rose only in the hover: found, and the hover measured.
    { name: "hover:bg-[var(--error)] with no other rose", bad: `bg-surface text-fg hover:bg-[var(--error)]`, theme: "both", needle: " hover: text-fg on bg-[var(--error)]", good: `bg-surface text-fg hover:bg-[var(--error)] hover:text-[var(--fg-on-error)]` },
  ];
  for (const s of shapes) {
    const bad = failing(`"${s.bad}"`);
    assert(
      pairsOf(`"${s.bad}"`).length >= 1 &&
        (s.theme === "both" ? bad.some((l) => l.includes(s.needle)) : onlyIn(bad, s.theme, s.needle)),
      `${s.name}: "${s.bad}" is found and fails on "${s.needle}" in ${s.theme} (failing: ${bad.join("; ") || "none"})`,
    );
    const goodPairs = pairsOf(`"${s.good}"`);
    const good = failing(`"${s.good}"`);
    assert(
      goodPairs.length >= 1 && good.length === 0,
      `${s.name}: the passing counterpart "${s.good}" is found and passes (${goodPairs.length} pairs, failing: ${good.join("; ") || "none"})`,
    );
  }
  // A hover inherits the rest paint of the theme it is in: under a dark rest
  // fill of white, the dark hover at 90% is measured over white, not the rose.
  const inherited = pairsOf(`"bg-[var(--error)] text-white dark:bg-white hover:opacity-90"`)[0]?.states ?? [];
  const darkHover = inherited.find((s) => s.themes.includes("dark"));
  assert(
    darkHover?.bg === "bg-white" && darkHover.restBg === "bg-white" && darkHover.opacity === 0.9 &&
      inherited.find((s) => s.themes.includes("light"))?.bg === "bg-[var(--error)]",
    `a hover inherits the rest fill of its own theme (got ${JSON.stringify(inherited)})`,
  );
  // A theme limited wash is not a rest fill, and the unlimited fill does not
  // answer for it: the dark cell is simply not a measurable pair.
  const washed = pairsOf(`"${onRose} dark:bg-error/20"`)[0]?.rest ?? [];
  assert(
    washed.length === 1 && JSON.stringify(washed[0].themes) === '["light"]',
    `a dark wash leaves the dark rest unmeasured rather than falling back to the light fill (got ${JSON.stringify(washed)})`,
  );
  // A state that paints its OWN fill and label is a complete pair whatever the
  // rest holds, so it is measured even when the literal has no opaque rest pair
  // at all. Only the step from rest needs a rest fill, and where there is none
  // that is REPORTED on `unmeasured`, never dropped in silence (L98).
  const noRest = `"text-fg hover:bg-[var(--error)] hover:text-white"`;
  const noRestFails = failing(noRest);
  assert(
    pairsOf(noRest).length === 1 && pairsOf(noRest)[0].rest.length === 0 &&
      noRestFails.some((l) => l.includes(" hover: text-white on bg-[var(--error)]") && l.endsWith("(dark)")),
    `a hover with its own fill and label and no rest fill is found and fails in dark (failing: ${noRestFails.join("; ") || "none"})`,
  );
  const noRestGood = `"text-fg hover:bg-[var(--error)] hover:text-[var(--fg-on-error)]"`;
  const noRestGoodPair = pairsOf(noRestGood)[0];
  assert(
    noRestGoodPair?.states.length === 1 && failing(noRestGood).length === 0 &&
      noRestGoodPair.unmeasured.some((u) => u.includes("hover") && u.includes("step from rest")),
    `its passing counterpart is measured, passes, and reports the step from rest as unmeasured (got ${JSON.stringify(noRestGoodPair)})`,
  );
  // The same when a WASH wins the rest in one theme: the dark hover still
  // paints its own fill and label, so it is measured there.
  const washRest = `"bg-surface text-fg dark:bg-error/20 hover:bg-[var(--error)] hover:text-white"`;
  const washFails = failing(washRest);
  assert(
    // Named `dark:hover` in dark because the dark rest class limits what it steps from.
    onlyIn(washFails, "dark", " dark:hover: text-white on bg-[var(--error)]"),
    `a hover over a theme whose rest is a wash is measured in that theme and fails there (failing: ${washFails.join("; ") || "none"})`,
  );
  const washGood = `"bg-surface text-fg dark:bg-error/20 hover:bg-[var(--error)] hover:text-[var(--fg-on-error)]"`;
  const washGoodPair = pairsOf(washGood)[0];
  assert(
    failing(washGood).length === 0 &&
      (washGoodPair?.states ?? []).some((s) => s.themes.includes("dark")) &&
      (washGoodPair?.unmeasured ?? []).some((u) => u.includes("(dark)") && u.includes("step from rest")),
    `its passing counterpart is measured in dark and reports the dark step from rest as unmeasured (got ${JSON.stringify(washGoodPair)})`,
  );
  // One literal read as several candidate pairs (two fills written side by side)
  // reports each thing it could not measure ONCE, not once per candidate, or the
  // sweep prints the same note line again for every pair of the literal.
  const twoFills = `"bg-surface bg-white text-fg dark:bg-error/20 hover:bg-[var(--error)] hover:text-[var(--fg-on-error)]"`;
  const twoFillPairs = pairsOf(twoFills);
  const twoFillNotes = twoFillPairs.flatMap((p) => p.unmeasured);
  assert(
    twoFillPairs.length === 2 && twoFillNotes.length === 1 && twoFillNotes[0].includes("(dark)"),
    `a literal with two candidate pairs reports its unmeasured step once (${twoFillPairs.length} pairs, notes: ${JSON.stringify(twoFillNotes)})`,
  );
  // The sweep's rest guard derives what it expects from the literal alone, not
  // from the scanner (L70). A `dark:` wash wins the dark rest, which the scanner
  // deliberately leaves unmeasured, so the guard must not expect dark there,
  // while still expecting both themes of an ordinary pair.
  {
    const src = [
      `const washed = "bg-[var(--error)] text-[var(--fg-on-error)] dark:bg-error/20";`,
      `const plainPair = "bg-[var(--error)] text-[var(--fg-on-error)]";`,
    ].join("\n");
    const expected = expectedRestThemes("fixture.ts", src);
    const measured = new Map<string, Set<Theme>>();
    for (const pair of scanRosePairings(src, isColourToken)) {
      measured.set(`fixture.ts:${pair.line}`, measuredRestThemes(pair, "fixture"));
    }
    assert(
      JSON.stringify([...(expected.get("fixture.ts:1") ?? [])]) === '["light"]' &&
        JSON.stringify([...(expected.get("fixture.ts:2") ?? [])]) === '["light","dark"]',
      `the rest guard expects light only under a dark wash, and both themes otherwise (got ${JSON.stringify([...expected].map(([k, v]) => [k, [...v]]))})`,
    );
    assert(
      restGaps(expected, measured).length === 0,
      `the rest guard stays green over a dark wash the scanner leaves unmeasured (gaps: ${restGaps(expected, measured).join(", ") || "none"})`,
    );
    // The light only mutation, applied to the measurement: the guard must still
    // name the ordinary pair whose dark rest went unmeasured.
    const lightOnly = new Map([...measured].map(([k, v]) => [k, new Set([...v].filter((t) => t === "light"))]));
    assert(
      JSON.stringify(restGaps(expected, lightOnly)) === '["fixture.ts:2 (dark)"]',
      `the rest guard still fails when a dark rest goes unmeasured (gaps: ${restGaps(expected, lightOnly).join(", ") || "none"})`,
    );
  }
  // A literal on a comment line describes a treatment rather than painting one,
  // so it is not found; the same literal as code is.
  const quoted = "bg-error/10 text-error hover:bg-error/20";
  assert(
    pairsOf(`/**\n * the old button (\`${quoted}\`) failed\n */`).length === 0 &&
      pairsOf(`// "${quoted}"`).length === 0 &&
      pairsOf(`const cls = "${quoted}";`).length === 1,
    "a class string quoted in a comment is not a pairing, and the same string in code is",
  );
  // The unprefixed pair still reads as one rest entry measured in both themes.
  const plain = pairsOf(`"${onRose}"`)[0]?.rest ?? [];
  assert(
    plain.length === 1 && JSON.stringify(plain[0].themes) === '["light","dark"]' && plain[0].opacity === 1,
    `an unprefixed rose pair is one rest entry in both themes (got ${JSON.stringify(plain)})`,
  );
}

// The rose hover step itself, by name, in both themes: the label on it, the step
// from the rest fill, and the fill against every surface. The sweep reaches it
// through the class string; this reaches it through the token, so a class string
// that stopped using it cannot take the measurement with it.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  const hoverFill = read("--error-hover");
  atLeast(read("--fg-on-error"), hoverFill, 4.5, `danger label on the rose hover fill (${theme})`);
  atLeast(hoverFill, read("--error"), HOVER_STEP, `the rose hover fill is a visible step from rest (${theme})`);
  for (const surface of STATE_BEHIND) {
    atLeast(hoverFill, read(surface), 3, `the rose hover fill against ${surface} (${theme})`);
  }
}

let rosePairsMeasured = 0;
let roseStatesMeasured = 0;
// Where the sweep measured a rest ratio, by `file:line`, and in which themes.
const restMeasuredAt = new Map<string, Set<Theme>>();
// The literals that MUST have a rest ratio measured, and in which themes, derived
// from the tree independently of the scanner by `expectedRestThemes`: the shape
// the scan read before #2866, which the per theme resolver can only add to, so
// one that dropped a rest pair or a theme leaves one of these unmeasured (L70).
const restExpectedAt = new Map<string, Set<Theme>>();
for (const file of rosePairFiles) {
  for (const [at, themes] of expectedRestThemes(file, readFileSync(file, "utf8"))) restExpectedAt.set(at, themes);
}
for (const file of rosePairFiles) {
  const src = readFileSync(file, "utf8");
  for (const pair of scanRosePairings(src, isColourToken)) {
    rosePairsMeasured++;
    const at = `${file}:${pair.line}`;
    const themes = restMeasuredAt.get(at) ?? new Set<Theme>();
    for (const t of measureRest(pair, at)) themes.add(t);
    restMeasuredAt.set(at, themes);
    roseStatesMeasured += measureStates(pair, `${file}:${pair.line}`);
    // What the sweep could not judge is printed, so a green run never reads as
    // more than it measured (L98).
    for (const u of pair.unmeasured) console.log(`note: ${file}:${pair.line} ${u}`);
    for (const cls of pair.unrecognised) {
      fail(
        `${file}:${pair.line} ${cls} carries a variant the rose state scan does not know; ` +
          "teach parseVariantChain in scripts/lib/scan-rose-pairings.ts which theme and state it applies in",
      );
    }
  }
}
// One interactive rose state exists today: the destructive button's hover, whose
// colours live in ONE constant that the booker's danger variant and the lead's
// cancel confirm both read. Fewer than one means the sweep lost it (L98).
assert(roseStatesMeasured >= 1, `the rose state sweep measured ${roseStatesMeasured} interactive states in src (expects at least 1)`);
// Every literal holding an unprefixed rose pair must have had its rest measured
// in every theme it is expected in (both, unless a `dark:` wash wins the dark
// rest). The expectation comes from the tree rather than the scanner, so a
// resolver that loses a theme or a whole rest pair fails here (L98).
const restUnmeasured = restGaps(restExpectedAt, restMeasuredAt);
assert(
  restExpectedAt.size >= 4 && restUnmeasured.length === 0,
  `every unprefixed rose pair in src had its rest measured in each expected theme ` +
    `(${restExpectedAt.size} expected, unmeasured: ${restUnmeasured.join(", ") || "none"})`,
);
// Four literals hold a rose pairing today: the destructive fill constant (which
// the booker's danger variant and the lead's cancel confirm both read since
// #2836, where they were two copies), the admin panel's one destructive confirm
// constant, and the sync banner with its link. A sweep that measured fewer read
// the wrong tree or lost its pattern rather than finding a clean one (L98).
assert(rosePairsMeasured >= 4, `the rose pairing sweep measured ${rosePairsMeasured} pairs in src (expects at least 4)`);

// --- #4104: the booking pace on Team capacity (design #4101) -------------------------------------
//
// The pace lines and the time off lines are muted text on a day card, which is the plain surface,
// the warm nearly full tint or the rose full tint; the one line under the cards when the pace
// cannot be read is the error colour, then muted, on the page itself. Text, so 4.5:1 each.
for (const [theme, read] of [
  ["light", r],
  ["dark", rDark],
] as [string, (n: string) => RGB][]) {
  for (const card of ["--surface", "--tc-flag-card", "--tc-full-card"]) {
    atLeast(read("--fg-muted"), read(card), 4.5, `a pace line on the ${card} day card (${theme})`);
  }
  atLeast(read("--error"), read("--bg"), 4.5, `the pace notice, error colour on the page (${theme})`);
  atLeast(read("--fg-muted"), read("--bg"), 4.5, `the pace notice's muted half on the page (${theme})`);
}


finish();
