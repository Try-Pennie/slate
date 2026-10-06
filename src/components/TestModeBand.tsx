import { DEMO_MODE_COPY, TEST_MODE_COPY } from "@/lib/booking/booker-copy";
import { isDemoBucket } from "@/lib/embed/public-test-bucket";

/**
 * The test mode marker (#2660): the one treatment in Slate that says "this
 * booking is a test", and the only place it is drawn from.
 *
 * Two shapes of one thing. The BAND carries the whole sentence and sits at the
 * top of every screen a tester or a stray lead reads (the booker in every state,
 * the manage page). The MARK is the word alone, beside a booking where a sentence
 * would be repeated once per row (the admin lookup, the booking detail).
 *
 * It is painted in mint on graphite, which is used functionally nowhere else in
 * the product (DESIGN.md, The Test Mode Rule), for the same reason the
 * impersonation marker is a hazard stripe: a banner announcing a special mode
 * has to look like nothing else, or it reads as chrome (L623). No per theme
 * override, so the same paint is correct on the beige and the dark booker;
 * `scripts/test-contrast.ts` measures the pair and
 * `scripts/test-test-mode-marker-unique.ts` refuses a second surface using it.
 *
 * `role="note"`, not `status`: it is a standing fact about the screen, not an
 * update, so it is read in place and never announced on top of the content.
 */
export function TestModeBand({
  framed = false,
  bucketCode,
}: {
  framed?: boolean;
  /** The booking's bucket. The demo bucket (#3424) draws the same band in its own
   *  words, because its bookings cancel themselves. */
  bucketCode?: string;
} = {}) {
  const copy = bucketCode !== undefined && isDemoBucket(bucketCode) ? DEMO_MODE_COPY : TEST_MODE_COPY;
  // #2748: `framed` is the booker inside the widget's iframe, where the host's
  // close control sits over the frame's top right corner. The band stops short of
  // it (64px: the control's 12px inset, its 44px width and its 8px focus ring), so
  // the control sits on the card rather than on the band and its ring never
  // crosses the band's edge. `embed-one-size.test.tsx` derives the number from
  // `public/widget.js`, so the two cannot drift apart.
  return (
    <div
      className={framed ? "pn-test-mode me-16" : "pn-test-mode"}
      role="note"
      data-testid="test-mode-band"
    >
      <span aria-hidden="true" className="pn-test-mode-glyph">
        {copy.label}
      </span>
      <span className="pn-test-mode-say">{copy.line}</span>
    </div>
  );
}

/** The word alone, for a row or a heading where the sentence would repeat. */
export function TestMark() {
  return <span className="pn-test-mode-mark">{TEST_MODE_COPY.label}</span>;
}
