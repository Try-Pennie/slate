import type { ReactNode } from "react";

/**
 * How far a MARK beside a word has to move UP to sit on the word's optical
 * centre, in px (#2112, and #2081 which found it inside the pill).
 *
 * `items-center` centres each child's BOX, and a word's box is its line box,
 * which reserves descender space most of these labels never use. So the letters
 * sit above the centre of their own box and a mark centred beside them reads as
 * low, even though both are perfectly centred in the row (L591).
 *
 * MEASURED, not chosen, with a canvas `TextMetrics` read on the rendered page in
 * the shipped font (PP Mori). The offset the letters want is
 * `(ascent - descent - capHeight) / 2`, and `capHeight` is
 * `actualBoundingBoxAscent` of a lone capital rather than of the label, since an
 * ascender in the word would read taller than a capital.
 *
 * ONE PIXEL COVERS EVERY SIZE `MarkedLabel` IS USED AT, which is `text-xs` and
 * `text-sm` and nothing else. Read back off the running app, on a real row, with
 * this component's own nudge applied:
 *
 * | class       | size / line height | letters want | left out |
 * |-------------|--------------------|--------------|----------|
 * | `text-xs`   | 12 / 16            | 0.7px        | 0.2px    |
 * | `text-sm`   | 14 / 20            | 0.9px        | 0.1px    |
 * | `text-base` | 16 / 24            | 1.1px        | 0.6px    |
 *
 * So `text-base` is OUTSIDE what this covers, and it is in the table for that
 * reason rather than as a third supported size: half a pixel is where a residual
 * starts being visible, which is the whole complaint #2112 was opened about. A
 * label at 16px wants its own reading, and the method is in this docstring.
 *
 * THE SIZE AND ITS LINE HEIGHT ARE ONE FACT, and the reading is worthless if they
 * are separated. Measured with the size changed and the line height left at 20px,
 * `text-base` reads as a whole pixel out and 13px as 0.8px out, which is a state
 * no call site can be in: every one of them sets a Tailwind size class, and each
 * of those carries its paired line height. The first sweep did exactly that and
 * reported two sizes as broken (L48).
 *
 * The derivation has a control at 13px, which is not a size used here: it
 * reproduces the 1.05 recorded on `PILL_LABEL_OPTICAL_NUDGE_PX` months earlier by
 * a different route, so a new row of this table can be checked against a reading
 * nobody took while looking at this component. Weight makes no difference, because
 * ascent and descent are the font's and not the face's, and both weights are in
 * the sweep above for that reason.
 */
export const MARK_OPTICAL_NUDGE_PX = 1;

/** Literal because Tailwind scans source text and cannot see a computed class.
 *  `MarkedLabel.test.tsx` holds it equal to the constant above. */
const MARK_OPTICAL_CLS = "relative top-[-1px]";

/**
 * A small shape beside a word, aligned to the word's LETTERS.
 *
 * ONE PLACE, because it was seven (#2112). The same construction is written by
 * hand on the account menu's three calendar states, both of the sync health
 * panel's rows, the booker's live indicator and the time off page's editing
 * badge, and each of them is a pixel out for one cause. Reported from whichever
 * screen somebody happens to be looking at, it reads as seven bugs.
 *
 * THE MARK MOVES HERE, and the LABEL moves inside `Pill`. That is not an
 * inconsistency: a pill has an oval to sit in, so moving its label down puts the
 * word's optical centre where the mark already is, which is the oval's centre.
 * Out here there is no oval, so moving the mark is the same alignment with
 * nothing else to satisfy, and it leaves the text exactly where the layout put
 * it. The pill therefore does NOT use this, deliberately.
 *
 * The mark is the caller's: its colour and its size say what the row means, and
 * this owns only where it sits. It is hidden from assistive technology here
 * rather than at each call site, because a decorative shape beside a word that
 * already says the same thing is decoration everywhere it appears.
 */
export function MarkedLabel({
  mark,
  children,
  className,
}: {
  /** The shape itself. The caller owns its size and colour. */
  mark: ReactNode;
  children: ReactNode;
  /** The row's own classes: its text size, its colour, and the gap it wants. */
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>
      <span aria-hidden="true" data-marked-label-mark="" className={`inline-flex shrink-0 ${MARK_OPTICAL_CLS}`}>
        {mark}
      </span>
      {children}
    </span>
  );
}
