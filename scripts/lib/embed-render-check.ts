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
  "link-refused",
  "load-failed",
  "csp-violations",
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
   * Whether the BOOKER ITSELF mounted, judged by its own chrome rather than by
   * how much text is on screen.
   *
   * This is the correction that matters. Judging on text alone was measured wrong
   * in BOTH directions against the real deployment on 2026-09-02: the booker's own
   * refusal screens ("This booking link is missing its configuration (no xbc)",
   * 56 characters) sailed past a length floor and reported a broken link as a
   * healthy render, while a shorter one ("This booking link is not available",
   * 35 characters) reported a correctly-refused link as a blank booker and named
   * the wrong repair. A quantity computed over the whole surface is answered by
   * whatever that surface paints for itself (L146, L115).
   *
   * The marker is the booker's own timezone control or its heading, both of which
   * live in the event panel and are NOT conditional on there being any slots, so
   * the empty-week state this check is built to tolerate still counts as mounted.
   * Measured on the real deployment: a working booker has both, and each refusal
   * screen has neither.
   */
  bookerMounted: boolean;
  /**
   * Text the booker rendered INSIDE the frame. Kept as EVIDENCE for the message
   * rather than as the verdict: it is what tells a blank frame from a frame
   * holding the booker's own refusal.
   */
  frameText: string;
  /** Browser console errors and uncaught page errors, in the order seen. */
  consoleErrors: string[];
  /**
   * Content Security Policy refusals the browser reported, in ANY frame (#2565).
   *
   * Separated from `consoleErrors` deliberately. A policy that breaks the embed
   * fails SILENTLY from our side: the booker is in an iframe on somebody else's
   * page, so the only place the error appears is a console we never see, and by
   * the time anyone notices, leads have been meeting a blank panel. This is the
   * one signal that sees it, and folding it in with ordinary console errors would
   * let an unrelated error answer for it and name the wrong repair (L11).
   *
   * While the policy is REPORT ONLY a violation breaks nothing, which is exactly
   * why it is worth having: it is the advance warning that enforcing WOULD.
   */
  cspViolations: string[];
}

/** The booker's own refusal, quoted so the reader sees which one it was. */
export interface EmbedVerdict {
  outcome: EmbedRenderOutcome;
  /** One sentence, naming what to do rather than what broke. */
  reason: string;
}

/**
 * Whether the frame holds anything at all.
 *
 * No longer the test for "the booker mounted" (see `bookerMounted`), only the
 * test for whether there is a frame with content in it, which is what separates a
 * blank panel from the booker's own refusal screen. A blank panel is not always
 * literally empty, so the floor is a few characters rather than one.
 */
export const FRAME_TEXT_FLOOR = 10;

/**
 * Whether a console line is the browser refusing something under the policy.
 *
 * Matched on the browser's own wording rather than on our policy's contents,
 * because the line we need to recognise is written by the browser and names the
 * directive it enforced. Chrome and Firefox both say "Content Security Policy";
 * the report only variants say "would refuse" or name the report only directive,
 * so the match is deliberately loose about the verb and strict about the phrase.
 */
export function isCspRefusal(text: string): boolean {
  return /content security policy/i.test(text);
}

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
  if (!o.bookerMounted) {
    // The booker did not mount. WHY it did not is the difference between a fault
    // and a correctly refused link, and the frame's text is what tells them apart.
    if (o.frameText.trim().length >= FRAME_TEXT_FLOOR) {
      return {
        outcome: "link-refused",
        reason:
          "The booker refused the link rather than failing: it drew its own message and none " +
          "of its booking chrome. That is a configuration problem with the link this check " +
          `uses, not an outage. It said: ${o.frameText.trim().slice(0, 120)}`,
      };
    }
    return {
      outcome: "frame-blank",
      reason:
        "The embed's modal opened and the booker never drew anything inside it. This is the " +
        "blank booker: a lead clicking Book gets an empty panel. Open /book directly to see " +
        "whether the page itself is broken or only the embedded route is.",
    };
  }
  if (o.cspViolations.length > 0) {
    // Ranked ABOVE console errors on purpose: a CSP refusal is reported through
    // the console too, so asking about console errors first would mean this
    // outcome could never fire and would read as a policy nothing ever violated.
    const first = o.cspViolations[0];
    return {
      outcome: "csp-violations",
      reason:
        `The embedded booker drew, and the browser refused ${o.cspViolations.length} ` +
        `thing${o.cspViolations.length === 1 ? "" : "s"} against the content security policy. ` +
        "The policy is enforced, so whatever was refused did not load inside the embed. " +
        `Read tag=csp-report in the Worker logs. ` +
        `First refusal: ${first}`,
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
    reason: "The embedded booker opened and drew its own booking chrome.",
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
