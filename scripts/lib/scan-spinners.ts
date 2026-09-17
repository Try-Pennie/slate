/**
 * Scan for a component drawing its own spinner (#1792).
 *
 * Two spinners existed, character for character identical except the size, inline
 * in `LinkPending.tsx` and `SubmitButton.tsx`, with no shared component. Third
 * instance of that pattern in a week, after the time pickers (#1765) and the
 * focus rings (#1768).
 *
 * The recipe itself was the ugly part: a circle with one border edge turned
 * transparent (`rounded-full border-2 border-current border-t-transparent`), which
 * leaves hard square ends where the transparent edge meets the solid one and at
 * 14px reads as a crude broken ring rather than a drawn arc. And `border-current`
 * meant the cue's colour changed with whichever control you happened to click.
 *
 * So the rule is narrow and mechanical, in the shape of `scan-focus-rings.ts`:
 * ONE component owns the spinner, and no other file may draw one. Both signatures
 * are refused, because the fix for the recipe and the fix for the duplication are
 * the same fix, and a caller that copied the classes without `animate-spin` would
 * still be a second cue.
 *
 * `BobbingDots` is deliberately NOT caught: it is the LEAD facing cue, it is a
 * separate decision (see its own docstring), and it animates through `pn-bob`
 * rather than `animate-spin`. A scanner that over matched it would be refusing
 * the thing it is meant to leave alone.
 */

/** A site the scanner objected to. */
import { hasOptOut } from "./opt-out.ts";

export interface SpinnerSite {
  file: string;
  line: number;
  /** The offending utility, so the message names it rather than the whole class. */
  utility: string;
  why: string;
}

/** The one file allowed to draw a spinner. */
export const SPINNER_COMPONENT = "src/components/ui/Spinner.tsx";

/**
 * The two signatures of a hand drawn spinner. `animate-spin` is the rotation, and
 * `border-t-transparent` is the broken ring recipe, refused separately so a copy
 * that drives the rotation some other way is still caught.
 */
const SIGNATURES: [RegExp, string][] = [
  [
    /\banimate-spin\b/,
    "only Spinner.tsx may draw a spinner; import it rather than starting a second one",
  ],
  [
    /\bborder-t-transparent\b/,
    "the transparent border edge recipe leaves hard square ends; Spinner.tsx draws an arc with round caps",
  ],
];

/**
 * Every place `text` draws its own spinner. `file` is used only for the reported
 * path and for the one allowed exemption, so the caller can scan content it has
 * not written to disk, which is how the positive controls run against the REAL
 * tree without touching it.
 */
export function scanSpinners(file: string, text: string): SpinnerSite[] {
  if (file === SPINNER_COMPONENT) return [];
  const lines = text.split("\n");
  const out: SpinnerSite[] = [];

  lines.forEach((line, i) => {
    // The opt-out sits on the line, or in the `//` block directly above it, which
    // is the convention every other guard in this tree uses.
    if (hasOptOut(lines, i, "spinner-ok:")) return;

    for (const [re, why] of SIGNATURES) {
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, utility: m[0], why });
    }
  });

  return out;
}
