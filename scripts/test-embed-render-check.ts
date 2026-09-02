// The embed render check's decision logic (#1006), driven offline. Run:
//   node --experimental-strip-types scripts/test-embed-render-check.ts
//
// The live command needs a browser and a deployment, so its rules are pinned here
// instead, the same way every other live command in this repo has an offline twin
// (the availability truth probe, the burst counter, the OOO protection sweep).
//
// The thing most worth pinning is what this check does NOT demand. The obvious
// version ("the modal opened and there is at least one bookable time") would be
// red every run from the day it shipped: before cutover the roster is deliberately
// dark, so a real bucket legitimately offers nothing. An alert that cries wolf
// gets ignored (L36), and this one has to still be believed on the day the embed
// actually breaks.
import {
  EMBED_RENDER_OUTCOMES,
  FRAME_TEXT_FLOOR,
  embedHostPage,
  judgeEmbedRender,
  type EmbedObservation,
} from "./lib/embed-render-check.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A healthy observation, so each case changes exactly one thing. */
function seen(over: Partial<EmbedObservation> = {}): EmbedObservation {
  return {
    modalPresent: true,
    loadFailedShown: false,
    frameText:
      "Loan Consultation. Pick a time that works for you. Nobody is available before then.",
    consoleErrors: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The healthy case, first, so every failure below is a change from something
// that really passes (L1 in reverse: a negative that cannot be contrasted with a
// positive proves nothing).
// ---------------------------------------------------------------------------

eq(judgeEmbedRender(seen()).outcome, "rendered", "a booker that drew its own content passes");

// The case the whole design turns on: a booker offering NO times still passes,
// because it said so in its own words. Demanding slots would make this check red
// for the entire pre-cutover period, which is most of its life so far.
eq(
  judgeEmbedRender(
    seen({ frameText: "Loan Consultation. Nobody is available before then. You can still book the first days back." }),
  ).outcome,
  "rendered",
  "a booker with no times to offer has still RENDERED, and must not read as broken",
);

// ---------------------------------------------------------------------------
// The three render faults, each its own outcome because each names a different
// repair (L11)
// ---------------------------------------------------------------------------

eq(
  judgeEmbedRender(seen({ modalPresent: false })).outcome,
  "modal-missing",
  "a trigger click that opened nothing is the embed script failing, not the booker",
);
eq(
  judgeEmbedRender(seen({ loadFailedShown: true })).outcome,
  "load-failed",
  "the embed's own retry panel means the iframe never loaded",
);
eq(
  judgeEmbedRender(seen({ frameText: "" })).outcome,
  "frame-blank",
  "a modal with nothing drawn inside it is the blank booker this check exists for",
);

// Whitespace is not content. A frame holding a newline and two spaces is exactly
// as blank to a lead as an empty one.
eq(
  judgeEmbedRender(seen({ frameText: "   \n\t  " })).outcome,
  "frame-blank",
  "whitespace does not count as having rendered",
);

// The floor is a floor, checked from both sides so it cannot quietly become zero
// (which would pass any stray character) or the whole page (which would fail the
// shortest real state).
{
  const justUnder = "x".repeat(FRAME_TEXT_FLOOR - 1);
  const justOver = "x".repeat(FRAME_TEXT_FLOOR);
  eq(judgeEmbedRender(seen({ frameText: justUnder })).outcome, "frame-blank",
    "one character under the floor is still blank");
  eq(judgeEmbedRender(seen({ frameText: justOver })).outcome, "rendered",
    "and the floor itself counts as rendered");
}

// The ORDER matters, and is asserted rather than assumed. The embed's load-failed
// panel is itself short text inside a modal, so a blankness test asked first would
// swallow it and name the wrong repair.
eq(
  judgeEmbedRender(seen({ loadFailedShown: true, frameText: "" })).outcome,
  "load-failed",
  "the embed's own failure panel is reported as itself, not as a blank frame",
);
// And a modal that never opened outranks everything, because every later question
// is meaningless without it.
eq(
  judgeEmbedRender(
    seen({ modalPresent: false, loadFailedShown: true, frameText: "", consoleErrors: ["boom"] }),
  ).outcome,
  "modal-missing",
  "a missing modal outranks every later question, which it makes meaningless",
);

// ---------------------------------------------------------------------------
// The console, which is the diagnosis the browser already made (L219)
// ---------------------------------------------------------------------------

{
  const v = judgeEmbedRender(seen({ consoleErrors: ["TypeError: x is not a function"] }));
  eq(v.outcome, "console-errors", "a page that drew and logged errors does not simply pass");
  assert(v.reason.includes("TypeError: x is not a function"),
    "and the first error is carried into the message, so the reader has the diagnosis");
  assert(/not an outage/i.test(v.reason),
    "while saying plainly that the booker is still rendering, so it is not read as one");
}

// Deliberately LAST: it is the only outcome that can be true of a page that drew
// correctly, so it must never mask an actual render fault.
eq(
  judgeEmbedRender(seen({ frameText: "", consoleErrors: ["boom"] })).outcome,
  "frame-blank",
  "a blank frame is reported as blank even when the console also complained",
);

// Singular and plural both read, because a message is read by a person.
{
  const one = judgeEmbedRender(seen({ consoleErrors: ["a"] })).reason;
  const two = judgeEmbedRender(seen({ consoleErrors: ["a", "b"] })).reason;
  assert(/1 error\b/.test(one), "one error reads in the singular");
  assert(/2 errors\b/.test(two), "and two in the plural");
}

// ---------------------------------------------------------------------------
// Every outcome says something, and says it in Slate's voice
// ---------------------------------------------------------------------------

const byOutcome = new Map(
  [
    seen({ modalPresent: false }),
    seen({ loadFailedShown: true }),
    seen({ frameText: "" }),
    seen({ consoleErrors: ["boom"] }),
    seen(),
  ].map((o) => {
    const v = judgeEmbedRender(o);
    return [v.outcome, v.reason];
  }),
);
// Every declared outcome must be one some observation can actually produce: a
// verdict nothing can reach is dead code wearing a decision (L151).
for (const outcome of EMBED_RENDER_OUTCOMES) {
  assert(byOutcome.has(outcome), `some observation produces ${outcome}`);
  const reason = byOutcome.get(outcome)!;
  assert(reason.trim().length > 20, `${outcome} explains itself rather than naming a code`);
  assert(!/undefined|NaN|\[object Object\]/.test(reason), `${outcome} leaks no placeholder`);
  // Escapes, not literals: the style gate blocks any push whose new lines
  // contain a dash character, and it cannot tell the line BANNING one from a
  // line using one.
  assert(!/[\u2014\u2013]/.test(reason), `${outcome} carries no dash punctuation`);
}
eq(
  new Set(byOutcome.values()).size,
  byOutcome.size,
  "no two outcomes share a sentence, because two refusals that read the same are one refusal",
);

// ---------------------------------------------------------------------------
// The host page mirrors the snippet a real integrator ships
// ---------------------------------------------------------------------------

{
  const page = embedHostPage("https://slate.trypennie.app/", "120");
  // The trailing slash is dropped, or every URL in the page carries a double one.
  assert(!page.includes("app//"), "a trailing slash on the origin does not double up");
  assert(page.includes('src="https://slate.trypennie.app/widget.js"'),
    "it loads the DEPLOYED widget, which is the artifact under test");
  assert(page.includes('Cal("init", "review", { origin: "https://slate.trypennie.app" })'),
    "and initialises it the way the real snippet does");
  assert(page.includes("data-cal-link=") && page.includes("data-cal-namespace="),
    "the trigger carries the same attributes the embed binds to");
  assert(page.includes("xbc=120"), "and routes by the bucket code the check was given");
}

finish();
