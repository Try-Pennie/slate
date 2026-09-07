// The header wordmark's BASELINE, not its bottom edge (#2038).
//
// The nav labels and the Pennie wordmark share a baseline, which flexbox will do
// for us with `align-items: baseline`. There is one catch, and it is the whole
// reason this file exists: for a replaced element like an `<img>`, the baseline
// flexbox uses is the bottom MARGIN edge, and the wordmark's glyphs do not end
// there. The SVG's viewBox is 19.422 user units tall while the flat stems finish
// at 19.021, so 0.401 units of empty space sit below the baseline and baseline
// alignment lands the wordmark that fraction HIGH.
//
// A relative offset of exactly that fraction of the rendered height pushes the
// glyphs down onto the text baseline. (A negative bottom margin looks like the
// tidier answer and does nothing: Chrome aligns a replaced flex item by its
// border box bottom and never consults the margin, which was measured rather
// than assumed.) The number is therefore derived
// from three things that live in three different files, and this holds them
// together: change the artwork, the rendered height or the offset alone and the
// alignment silently goes wrong by an amount nobody can see in a diff (L41, L63).
//
// Run: node --experimental-strip-types scripts/test-wordmark-baseline.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const svg = readFileSync(join("public", "brand", "logo-pennie-charcoal.svg"), "utf8");
const cream = readFileSync(join("public", "brand", "logo-pennie-cream.svg"), "utf8");
const header = readFileSync(join("src", "components", "AppHeader.tsx"), "utf8");
const css = readFileSync(join("src", "app", "globals.css"), "utf8");

/** The viewBox height, and the y the flat stems finish at (the baseline). */
function metrics(source: string) {
  const box = /viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(source)?.[1];
  const ys = [...source.matchAll(/[ML] [-\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  // The baseline is the y the most anchors share, not the lowest one: the round
  // letters overshoot below it on purpose and would drag a max() answer down.
  const counts = new Map<number, number>();
  for (const y of ys) counts.set(y, (counts.get(y) ?? 0) + 1);
  let baseline = 0;
  let best = 0;
  for (const [y, n] of counts) if (n > best) { best = n; baseline = y; }
  return { height: Number(box), baseline, anchors: best };
}

const m = metrics(svg);
assert(Number.isFinite(m.height) && m.height > 0, `the viewBox height was read (got ${m.height})`);
assert(m.anchors >= 8, `the baseline was read from many stems, not one (${m.anchors} anchors at y=${m.baseline})`);
assert(
  m.baseline > 0 && m.baseline < m.height,
  `the baseline sits inside the viewBox (${m.baseline} of ${m.height})`,
);

// Both variants are the same artwork in two colours; a fix applied to one only
// would be right in one theme and wrong in the other.
const c = metrics(cream);
assert(
  c.height === m.height && c.baseline === m.baseline,
  `both wordmark variants share their metrics (light ${m.baseline}/${m.height}, dark ${c.baseline}/${c.height})`,
);

/** The rendered height the header asks for. */
const rendered = Number(/className="[^"]*\bh-\[(\d+(?:\.\d+)?)px\][^"]*"/.exec(header)?.[1]);
assert(Number.isFinite(rendered), `the header's wordmark height was read (got ${rendered})`);

const expected = rendered * (1 - m.baseline / m.height);

/** What the stylesheet actually pulls it up by. */
const declared = Number(
  /\.pn-wordmark\s*\{[^}]*?\btop:\s*([\d.]+)px/s.exec(css)?.[1],
);
assert(Number.isFinite(declared), `the wordmark's baseline offset was read from the CSS (got ${declared})`);

// A tenth of a pixel: tight enough that a wrong derivation fails, loose enough
// that rounding the constant to four decimals does not.
assert(
  Math.abs(declared - expected) < 0.05,
  `the offset (${declared}px) matches the artwork and the rendered height (${expected.toFixed(4)}px)`,
);

// The offset only does anything if the row actually aligns on baselines, so the
// two halves are checked together rather than the number alone being correct
// while nothing consumes it.
assert(
  /items-baseline/.test(header),
  "the header aligns the wordmark and the nav on their baselines",
);

// A positive control on the derivation: a wordmark whose stems ran all the way to
// the viewBox floor would need NO offset, so a non-zero expectation here is
// evidence the metrics were really read rather than defaulted.
assert(expected > 0.1, `the artwork really does carry space below its baseline (${expected.toFixed(4)}px)`);

finish();
