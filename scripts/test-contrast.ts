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


finish();
