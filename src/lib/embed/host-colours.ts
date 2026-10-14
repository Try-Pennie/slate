/**
 * The colours a host page may set on the booker (#3718).
 *
 * Two, as Dan settled on 2026-10-14: the button colour (`brand`, which cal.com's
 * `brandColor` and `cssVarsPerTheme["cal-brand"]` reach through widget.js) and, on
 * the inline card, the card's background (`bg`, from `cssVarsPerTheme["cal-bg"]`).
 * Geoff's landing pages change colour from page to page, so the card has to follow.
 *
 * Each is kept only when text on it can be read: the button's label and the card's
 * title must reach `MIN_TEXT_CONTRAST` in graphite or beige, whichever is better,
 * and that one becomes the text colour. A colour that cannot, or does not parse, is
 * REFUSED: Slate keeps its own default and the refusal is returned for the page to
 * log, because a host colour that silently did nothing would look like a bug on
 * their side with no way to find out why.
 *
 * The button rule is not new for the inline card only: every booker page reads
 * `brand` through here, so one rule decides it everywhere. trypennie's pop-up sends
 * `#000000` today, which reads at 18:1 and is unaffected.
 *
 * Pure. `scripts/test-host-colours.ts`.
 */
import { bestLabelFor, DEFAULT_BRAND_COLOR } from "../brand-label.ts";
import { log } from "../log.ts";

/** WCAG AA for normal text: the button label and the "Rather pick a time" line are 14px. */
export const MIN_TEXT_CONTRAST = 4.5;

/** How much of a refused value is logged: a #rrggbb colour fits several times over. */
const LOGGED_VALUE_CHARS = 32;

export interface HostColours {
  /** The button colour to paint, or undefined for the palette's own. */
  brandColor: string | undefined;
  /** The card's background and the text colour that reads on it, or undefined for Slate's card. */
  cardSurface: { background: string; ink: string } | undefined;
  /** Every colour the host sent that was not used, and why. */
  refused: { which: "brand" | "bg"; value: string; reason: string }[];
}

function judge(value: string): { ok: true; ink: string } | { ok: false; reason: string } {
  // The "#" is required here although `hexLuminance` would take a bare hex: a
  // browser drops a colour without one, which would leave Slate's card painted under
  // a text colour chosen for a background that never appeared.
  const label = value.trim().startsWith("#") ? bestLabelFor(value) : null;
  if (label === null) return { ok: false, reason: "not a #rgb or #rrggbb colour" };
  if (label.ratio < MIN_TEXT_CONTRAST) {
    return { ok: false, reason: `text on it reaches ${label.ratio.toFixed(2)}:1, under ${MIN_TEXT_CONTRAST}:1` };
  }
  return { ok: true, ink: label.css };
}

export function judgeHostColours(input: { brand: string | null; bg: string | null; embedded: boolean }): HostColours {
  const refused: HostColours["refused"] = [];
  // Embedded with no colour of its own, the button is Pennie sky (#1903), as before.
  const fallbackBrand = input.embedded ? DEFAULT_BRAND_COLOR : undefined;
  let brandColor = fallbackBrand;
  if (input.brand) {
    const v = judge(input.brand);
    if (v.ok) brandColor = input.brand;
    else refused.push({ which: "brand", value: input.brand, reason: v.reason });
  }
  let cardSurface: HostColours["cardSurface"];
  if (input.bg) {
    const v = judge(input.bg);
    if (v.ok) cardSurface = { background: input.bg, ink: v.ink };
    else refused.push({ which: "bg", value: input.bg, reason: v.reason });
  }
  return { brandColor, cardSurface, refused };
}

/**
 * What a booker page calls: the judgement, with every refusal logged once under
 * `tag=host-colours`, naming the page, the colour and why. The value is a colour the
 * host sent, never anything about a lead.
 */
export function readHostColours(
  input: { brand: string | null; bg: string | null; embedded: boolean },
  page: string,
  warn: (fields: Record<string, string>) => void = (fields) => log.warn("host-colours", fields),
): HostColours {
  const colours = judgeHostColours(input);
  // The value is whatever the page sent, of any length, so only its start is logged:
  // enough to recognise a colour, never a payload a caller chose to put in our logs.
  for (const r of colours.refused) {
    warn({ msg: "host colour refused", page, which: r.which, value: r.value.slice(0, LOGGED_VALUE_CHARS), reason: r.reason });
  }
  return colours;
}
