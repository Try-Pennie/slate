/**
 * Scan for a component declaring its own focus ring COLOUR (#1768).
 *
 * Twenty five sites across thirteen files set `focus-visible:outline-pennie-sky`,
 * and sky measures 1.57:1 on beige and 1.69:1 on white. Both fail the 3:1 that
 * WCAG 2.1 SC 1.4.11 requires of a focus indicator, so those rings were pretty and
 * close to invisible: the failure nobody reports, because a keyboard user cannot
 * tell you about a ring they never saw.
 *
 * The global recipe in `globals.css` is deliberately UNLAYERED (#39) so it beats
 * layered utilities, which means a per component ring was only ever needed where
 * the ring has to be suppressed or moved, and those cases have their own named
 * rules in the same file. So the rule here is narrow and mechanical: a component
 * may say a ring is absent, and it may not say what colour a ring is.
 *
 * WIDTH and OFFSET are allowed, because they are shape rather than contrast and a
 * small control legitimately tightens them. What is refused is a COLOUR, in any of
 * the ways Tailwind can express one, plus the whole `ring-*` family, which would be
 * a second recipe rather than an override of this one.
 */

import { hasOptOut } from "./opt-out.ts";

/** A site the scanner objected to. */
export interface FocusRingSite {
  file: string;
  line: number;
  /** The offending utility, so the message names it rather than the whole class. */
  utility: string;
  why: string;
}

/**
 * Utilities that follow `outline-` and are NOT a colour. Anything else after
 * `outline-` names one, including an arbitrary value like `outline-[#123456]` or
 * `outline-[var(--x)]`.
 */
const NOT_A_COLOUR = /^(?:offset-(?:-?\d|\[)|\d|none|hidden|solid|dashed|dotted|double)/;

/** `focus-visible:` / `focus:` / `focus-within:`, with any other variants stacked. */
const FOCUS_UTILITY = /(?:^|["'`\s])((?:[a-z-]+:)*(?:focus|focus-visible|focus-within):(?:[a-z-]+:)*(outline|ring)-([^\s"'`}]+))/g;

/**
 * Every place `text` declares a focus ring colour. `file` is used only for the
 * reported path, so the caller can scan content it has not written to disk, which
 * is how the positive control runs against the REAL tree without touching it.
 */
export function scanFocusRings(file: string, text: string): FocusRingSite[] {
  const lines = text.split("\n");
  const out: FocusRingSite[] = [];

  lines.forEach((line, i) => {
    // The opt-out sits on the line, or in the comment block directly above it,
    // read through the one shared reader every guard in this tree uses (#2200).
    if (hasOptOut(lines, i, "focus-ring-ok:")) return;

    for (const m of line.matchAll(FOCUS_UTILITY)) {
      const [, utility, family, value] = m;
      if (family === "ring") {
        // `ring-2` and friends draw a box shadow ring, which is a second recipe
        // rather than an override of the outline one: two rings on one control.
        out.push({
          file,
          line: i + 1,
          utility,
          why: "the ring-* family is a second focus recipe; the outline recipe in globals.css is the only one",
        });
        continue;
      }
      if (NOT_A_COLOUR.test(value)) continue;
      out.push({
        file,
        line: i + 1,
        utility,
        why: "a component may not name the focus ring colour; globals.css chooses it by surface",
      });
    }
  });

  return out;
}
