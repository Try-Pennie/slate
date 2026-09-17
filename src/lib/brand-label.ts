/**
 * Pure: pick a readable label color for an arbitrary host brand color (#36).
 * The embed lets hosts tint the Confirm CTA via the `brand` param; a graphite
 * label is right for light brands (Pennie sky: 7.36:1) but fails on dark ones
 * (navy: 1.5:1), so choose whichever of graphite/beige contrasts better.
 * Exercised by scripts/test-brand-label.ts.
 */

/**
 * The default brand fill the embed hands a host, as a literal (#1903).
 *
 * This is `--pennie-sky` and it is written here ONCE, because the embed passes
 * it across a boundary a CSS variable cannot travel over: the host consumes it
 * as a string and resolves it in its own document (D14). It lived in two page
 * files as `const PENNIE_SKY`, each calling itself canonical when neither was,
 * so either copy could drift from the token on its own.
 *
 * `scripts/test-raw-colour.ts` pins it to the token's own rgb() in globals.css,
 * which is what keeps the one literal honest rather than merely single.
 *
 * colour-ok: the embed hands this to a host as a string, and a CSS variable
 * cannot cross that boundary; it is pinned to the token by the guard above.
 */
export const DEFAULT_BRAND_COLOR = "#82D0FF";

/** Graphite #343434 - the on-sky label color from the design system. */
const GRAPHITE = { css: "var(--fg-on-sky)", luminance: relLum(52, 52, 52) };
/** Beige - the light label for dark brand fills, from the token like its pair. */
const BEIGE = { css: "var(--pennie-beige)", luminance: relLum(249, 246, 240) };

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relLum(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG relative luminance of a #rgb / #rrggbb color; null when unparseable. */
export function hexLuminance(hex: string): number | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return relLum((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The CTA label color for a host brand fill: graphite or beige, whichever
 * contrasts better. Unparseable input keeps the graphite default (matches
 * the no-brand sky CTA).
 */
export function labelColorFor(brandColor: string): string {
  const lum = hexLuminance(brandColor);
  if (lum === null) return GRAPHITE.css;
  return contrastRatio(lum, GRAPHITE.luminance) >=
    contrastRatio(lum, BEIGE.luminance)
    ? GRAPHITE.css
    : BEIGE.css;
}
