/**
 * What counts as the embedded booker having RENDERED (#1006).
 *
 * The pure half of the browser check, split out for the same reason every live
 * command in this repo has one: the decision logic is driven offline by
 * `scripts/test-embed-render-check.ts`, so the rules are tested even where a
 * browser is not available, and the live runner stays a thin driver.
 *
 * ## What this exists to catch, and what it deliberately does not assert
 *
 * The uptime canary proves the server responds; it cannot prove the front end
 * draws. cal.com is watched by a Checkly browser check that loads the embedded
 * scheduler and confirms the modal appears; Slate's embed had no equivalent, so a
 * front end or embed regression that left the booker blank would go unnoticed.
 *
 * It does NOT assert that slots are offered, and that is the important choice.
 * The obvious version of this check ("the modal opened and there is at least one
 * bookable time") is the cal.com Checkly trap in reverse: before cutover the
 * roster is deliberately dark (#1272, 2 of 126 users bookable), so a real bucket
 * legitimately offers nothing, and a check that demanded slots would be red every
 * run from the day it shipped. An alert that cries wolf gets ignored (L36), and
 * the whole point is to still be trusted on the day the embed actually breaks.
 *
 * What it asserts instead is that the booker SAYS SOMETHING. A working embed
 * either offers times or states, in its own words, why it has none. A broken one
 * shows a blank panel, a stuck loader, or the embed's own load-failed message.
 * Those are distinguishable without knowing anything about the roster.
 *
 * ## The three ways it can be wrong, each its own outcome (L11)
 *
 *  - `modal-missing`: the click did nothing. The embed script did not load, did
 *    not bind, or threw before it could open the dialog.
 *  - `frame-blank`: the modal opened and the booker never mounted. This is the
 *    literal "blank booker" the issue names.
 *  - `load-failed`: the embed itself gave up and showed its own retry panel,
 *    which means the iframe never loaded. A different repair from a blank frame:
 *    the origin is unreachable or blocked rather than the app being broken.
 *
 * And a fourth that is not a render fault at all but must never pass silently:
 *  - `console-errors`: the page drew, and the browser reported errors while doing
 *    it. A browser test that does not read the console throws away a diagnosis
 *    the browser already made (L219).
 */

/** Every way this check can end. Enumerated so each gets its own sentence, and so
 *  a new outcome cannot be added without someone writing one. */
export const EMBED_RENDER_OUTCOMES = [
  "rendered",
  "modal-missing",
  "frame-blank",
  "load-failed",
  "console-errors",
] as const;

export type EmbedRenderOutcome = (typeof EMBED_RENDER_OUTCOMES)[number];

/** What the browser actually observed, as plain data, so the verdict is a pure
 *  function of it and can be driven without a browser. */
export interface EmbedObservation {
  /** The embed's modal dialog appeared after the trigger was clicked. */
  modalPresent: boolean;
  /** The embed showed its own "we couldn't load the booking form" panel. */
  loadFailedShown: boolean;
  /**
   * Text the booker rendered INSIDE the frame. Empty (or whitespace) means the
   * frame is there and nothing mounted in it, which is the blank booker.
   */
  frameText: string;
  /** Browser console errors and uncaught page errors, in the order seen. */
  consoleErrors: string[];
}

export interface EmbedVerdict {
  outcome: EmbedRenderOutcome;
  /** One sentence, naming what to do rather than what broke. */
  reason: string;
}

/**
 * How much rendered text counts as "the booker mounted".
 *
 * A blank panel is not always literally empty: a mounted-but-failed React tree can
 * leave a stray character behind, and the embed's own chrome contributes a close
 * button. So the floor is a handful of characters rather than one, chosen to be
 * comfortably under the shortest real state (the booker's own heading plus its
 * empty-week explanation) and comfortably over any stray punctuation.
 */
export const FRAME_TEXT_FLOOR = 40;

/**
 * The verdict, in a fixed order.
 *
 * The order is by what the reader can act on. A modal that never opened makes
 * every later question meaningless, and the embed's own load-failed panel names a
 * different repair from a blank frame, so it is asked before the blankness test
 * that would otherwise also match it. Console errors come last because they are
 * the only outcome that can be true of a page that drew correctly.
 */
export function judgeEmbedRender(o: EmbedObservation): EmbedVerdict {
  if (!o.modalPresent) {
    return {
      outcome: "modal-missing",
      reason:
        "The embed's booking modal never opened after the trigger was clicked. widget.js did " +
        "not load, did not bind its click handler, or threw before opening the dialog. Check " +
        "that /widget.js still serves and that the page's Cal(\"init\") origin is right.",
    };
  }
  if (o.loadFailedShown) {
    return {
      outcome: "load-failed",
      reason:
        "The embed opened and then showed its own load-failed panel, so the booking iframe " +
        "never loaded. That points at the origin being unreachable or blocked rather than the " +
        "booker being broken: check the deployment and anything in front of it.",
    };
  }
  if (o.frameText.trim().length < FRAME_TEXT_FLOOR) {
    return {
      outcome: "frame-blank",
      reason:
        "The embed's modal opened and the booker never drew anything inside it. This is the " +
        "blank booker: a lead clicking Book gets an empty panel. Open /book directly to see " +
        "whether the page itself is broken or only the embedded route is.",
    };
  }
  if (o.consoleErrors.length > 0) {
    const first = o.consoleErrors[0];
    return {
      outcome: "console-errors",
      reason:
        `The embedded booker drew, and the browser reported ${o.consoleErrors.length} ` +
        `error${o.consoleErrors.length === 1 ? "" : "s"} while it did. It is rendering, so this ` +
        `is not an outage, but it is the browser telling us something is wrong: ${first}`,
    };
  }
  return {
    outcome: "rendered",
    reason: "The embedded booker opened and drew its own content.",
  };
}

/**
 * The host page the check drives.
 *
 * Built here rather than committed as a fixture file so it stays in one piece with
 * the contract it is meant to mirror, and so the offline test can assert the shape
 * without a browser. It is deliberately the SAME snippet shape a real integrator
 * uses (the one `docs`/the embed skill describe): a script tag pointing at the
 * deployed widget, a namespaced init carrying the origin, and a button with
 * `data-cal-link`. A fixture that drifted from the real snippet would be a check
 * on something nobody ships.
 */
export function embedHostPage(origin: string, bucket: string): string {
  const base = origin.replace(/\/$/, "");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Slate embed render check</title></head>
<body>
<button
  id="book"
  data-cal-link="router?form=review&xbc=${bucket}"
  data-cal-namespace="review"
  data-cal-config='{"layout":"month_view"}'
>Book a call</button>
<script src="${base}/widget.js"></script>
<script>
  Cal("init", "review", { origin: "${base}" });
</script>
</body>
</html>`;
}
