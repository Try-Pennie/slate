// Sanity test for the brand-color CTA label picker (#36).
// Run: node --experimental-strip-types scripts/test-brand-label.ts
import {
  contrastRatio,
  hexLuminance,
  labelColorFor,
} from "../src/lib/brand-label.ts";
import { assert, finish } from "./lib/harness.ts";

const GRAPHITE = "var(--fg-on-sky)";
// Both labels come from a token now (#1903): the graphite half already did, and
// the beige half was the last literal in the pair. The only consumer is the
// Booker's confirm button, which renders inside Slate's own document, so the
// variable resolves.
const BEIGE = "var(--pennie-beige)";

// luminance parsing
assert(hexLuminance("#ffffff") === 1, "white luminance is 1");
assert(hexLuminance("#000000") === 0, "black luminance is 0");
assert(hexLuminance("fff") === 1, "bare 3-digit hex parses");
assert(hexLuminance("#82D0FF") !== null, "pennie sky parses");
assert(hexLuminance("not-a-color") === null, "garbage returns null");
assert(hexLuminance("#82D0FF7F") === null, "alpha hex is rejected, not misread");

// the exact D17 pairing math must reproduce: graphite on sky = 7.36:1
const sky = hexLuminance("#82D0FF")!;
const graphite = hexLuminance("#343434")!;
assert(
  Math.abs(contrastRatio(sky, graphite) - 7.36) < 0.01,
  `graphite-on-sky reproduces the D17 ratio (got ${contrastRatio(sky, graphite).toFixed(2)})`,
);

// label picking
assert(labelColorFor("#82D0FF") === GRAPHITE, "pennie sky -> graphite label");
assert(labelColorFor("#FF8800") === GRAPHITE, "bright orange -> graphite label");
assert(labelColorFor("#ffffff") === GRAPHITE, "white -> graphite label");
assert(labelColorFor("#1D212F") === BEIGE, "pennie navy -> beige label");
assert(labelColorFor("#000000") === BEIGE, "black -> beige label");
assert(labelColorFor("#486CCA") === BEIGE, "pennie blue (dark-mid) -> beige label");
assert(labelColorFor("") === GRAPHITE, "empty input keeps the graphite default");
assert(labelColorFor("blue") === GRAPHITE, "named colors keep the graphite default");

// whichever label is picked must meet AA (4.5:1) for every plausible brand
const beige = hexLuminance("#F9F6F0")!;
for (const brand of ["#82D0FF", "#FF8800", "#1D212F", "#486CCA", "#ffffff", "#000000", "#777777"]) {
  const lum = hexLuminance(brand)!;
  const picked = labelColorFor(brand) === GRAPHITE ? graphite : beige;
  const ratio = contrastRatio(lum, picked);
  const other = contrastRatio(lum, picked === graphite ? beige : graphite);
  assert(ratio >= other, `${brand}: picked label is the higher-contrast one (${ratio.toFixed(2)} vs ${other.toFixed(2)})`);
}

finish();
