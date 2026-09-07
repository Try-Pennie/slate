// WCAG 2.x relative luminance and contrast ratio, in ONE place.
//
// Extracted from scripts/test-contrast.ts when a second guard needed the same
// arithmetic. A contrast number is only meaningful if every place that quotes
// one computed it the same way, and two hand rolled copies of this formula drift
// in the direction that flatters whatever is being argued (L107): a design record
// claiming 8.61:1 is worth nothing if the check that verifies it uses its own
// slightly different maths.
export type RGB = [number, number, number];

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([red, green, blue]: RGB): number {
  return 0.2126 * lin(red) + 0.7152 * lin(green) + 0.0722 * lin(blue);
}

/** The WCAG contrast ratio between two colours, order independent. */
export function ratio(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** `#RGB`, `#RRGGBB` or `rgb(r, g, b)` to an RGB triple. Throws on anything else. */
export function parseColor(raw: string): RGB {
  const text = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const h = hex[1];
    const wide = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [
      parseInt(wide.slice(0, 2), 16),
      parseInt(wide.slice(2, 4), 16),
      parseInt(wide.slice(4, 6), 16),
    ];
  }
  const fn = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/i.exec(text);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  throw new Error(`parseColor: cannot read ${JSON.stringify(raw)}`);
}
