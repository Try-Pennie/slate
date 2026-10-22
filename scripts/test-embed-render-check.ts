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
  type PanelObservation,
  isCspRefusal,
} from "./lib/embed-render-check.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A healthy observation, so each case changes exactly one thing. */
function seen(over: Partial<EmbedObservation> = {}): EmbedObservation {
  return {
    modalPresent: true,
    loadFailedShown: false,
    bookerMounted: true,
    frameText:
      "Loan Consultation. Pick a time that works for you. Nobody is available before then.",
    consoleErrors: [],
    cspViolations: [],
    panel: healthyPanel(),
    ...over,
  };
}

/** #1869: the timezone list opened, drawn, uncovered, focused, walkable and shut. */
function healthyPanel(over: Partial<PanelObservation> = {}): PanelObservation {
  return {
    found: true,
    opened: true,
    onScreen: true,
    unobscured: true,
    focusInside: true,
    walks: true,
    closesOnEscape: true,
    probeError: null,
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
  judgeEmbedRender(seen({ bookerMounted: false, frameText: "" })).outcome,
  "frame-blank",
  "a modal with nothing drawn inside it is the blank booker this check exists for",
);

// Whitespace is not content. A frame holding a newline and two spaces is exactly
// as blank to a lead as an empty one.
eq(
  judgeEmbedRender(seen({ bookerMounted: false, frameText: "   \n\t  " })).outcome,
  "frame-blank",
  "whitespace does not count as having rendered",
);

// ---------------------------------------------------------------------------
// The correction that this check would have shipped wrong without (#1006)
// ---------------------------------------------------------------------------
//
// The first version judged on how much TEXT was in the frame, and measuring it
// against the real deployment on 2026-09-02 showed it wrong in BOTH directions.
// The booker's own refusal screens are text, so a length floor is answered by
// whatever the surface paints for itself (L146, L115).
//
// These two fixtures are the REAL strings, measured, not invented.
{
  // 56 characters, which sailed past the old floor and reported a broken link as
  // a healthy render. The worst direction: false confidence on the check whose
  // whole job is to notice the embed is broken.
  const misconfigured = judgeEmbedRender(
    seen({
      bookerMounted: false,
      frameText: "This booking link is missing its configuration (no xbc).",
    }),
  );
  eq(misconfigured.outcome, "link-refused",
    "the booker's own 'missing configuration' screen is a refused link, never a healthy render");
  assert(misconfigured.reason.includes("missing its configuration"),
    "and the message quotes what the booker actually said, so the reader is not guessing");

  // 35 characters, which failed the old floor and named the wrong repair: it sent
  // the reader to look at a blank booker when the link was simply refused.
  const unavailable = judgeEmbedRender(
    seen({ bookerMounted: false, frameText: "This booking link is not available." }),
  );
  eq(unavailable.outcome, "link-refused",
    "and so is 'not available', which is a configuration problem rather than an outage");
  assert(/not an outage/i.test(unavailable.reason),
    "the message says so plainly, because this must not be read as the embed being down");
}

// The text floor now separates a blank frame from a refused link, which is a much
// smaller job than deciding whether the booker mounted. Checked from both sides so
// it cannot quietly become zero or swallow a real refusal.
{
  const justUnder = "x".repeat(FRAME_TEXT_FLOOR - 1);
  const justOver = "x".repeat(FRAME_TEXT_FLOOR);
  eq(judgeEmbedRender(seen({ bookerMounted: false, frameText: justUnder })).outcome,
    "frame-blank", "under the floor, an unmounted booker is blank");
  eq(judgeEmbedRender(seen({ bookerMounted: false, frameText: justOver })).outcome,
    "link-refused", "over it, the frame is holding something the booker chose to say");
}

// And the whole point of the structural marker: plenty of text does NOT mean the
// booker mounted. Without this, any error page long enough passes.
eq(
  judgeEmbedRender(seen({ bookerMounted: false })).outcome,
  "link-refused",
  "a frame full of text has still not rendered the booker if none of its chrome is there",
);

// The ORDER matters, and is asserted rather than assumed. The embed's load-failed
// panel is itself short text inside a modal, so a blankness test asked first would
// swallow it and name the wrong repair.
eq(
  judgeEmbedRender(seen({ loadFailedShown: true, bookerMounted: false, frameText: "" })).outcome,
  "load-failed",
  "the embed's own failure panel is reported as itself, not as a blank frame",
);
// And a modal that never opened outranks everything, because every later question
// is meaningless without it.
eq(
  judgeEmbedRender(
    seen({
      modalPresent: false,
      loadFailedShown: true,
      bookerMounted: false,
      frameText: "",
      consoleErrors: ["boom"],
    }),
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
  judgeEmbedRender(seen({ bookerMounted: false, frameText: "", consoleErrors: ["boom"] })).outcome,
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
// #1869: the floating panels. All four popups share one component (#1843), so the
// booker's timezone list stands for the row menu, the account menu and the date
// picker too. Each way it can fail in a real browser and pass in jsdom is its own
// sentence, because each names a different repair (L11).
// ---------------------------------------------------------------------------

eq(judgeEmbedRender(seen()).outcome, "rendered", "a timezone list that opens, draws, takes focus and walks passes");
{
  const cases: [Partial<PanelObservation>, RegExp, string][] = [
    [{ found: false }, /could not find the booker's timezone control/, "a missing control"],
    [{ opened: false }, /did not open/, "a list that never opened"],
    [{ onScreen: false }, /not drawn on screen/, "a list drawn off screen or with no size"],
    [{ unobscured: false }, /painted over/, "a list painted over by something else"],
    [{ focusInside: false }, /focus/, "a list opened with focus left outside it"],
    [{ walks: false }, /arrow key/, "a list the keyboard cannot walk"],
    [{ closesOnEscape: false }, /Escape/, "a list Escape does not close"],
  ];
  for (const [over, said, what] of cases) {
    const v = judgeEmbedRender(seen({ panel: healthyPanel(over) }));
    eq(v.outcome, "panel-broken", `${what} is a broken panel, not a render`);
    assert(said.test(v.reason), `${what} says which way it failed (got: ${v.reason})`);
  }
}
{
  // The probe itself failing is still a failure, named as the probe's own fault.
  const v = judgeEmbedRender(seen({ panel: healthyPanel({ probeError: "Timeout 5000ms exceeded" }) }));
  eq(v.outcome, "panel-broken", "a probe that could not run fails loudly rather than passing");
  assert(v.reason.includes("Timeout 5000ms exceeded"), "and quotes what stopped it");
}
// A mounted booker the panel was never opened on cannot pass: a probe skipped by a
// later edit would otherwise read as a panel that works (L98).
eq(judgeEmbedRender(seen({ panel: null })).outcome, "panel-broken", "a mounted booker with no panel reading is not a pass");
// An unmounted booker is judged as before: the panel question cannot be asked.
eq(
  judgeEmbedRender(seen({ bookerMounted: false, frameText: "", panel: null })).outcome,
  "frame-blank",
  "a blank booker is still a blank booker, not a broken panel",
);
// A CSP refusal can be the CAUSE of a broken panel, so it is named first.
eq(
  judgeEmbedRender(
    seen({
      panel: healthyPanel({ opened: false }),
      cspViolations: ["Refused to load the script because it violates the following Content Security Policy directive"],
    }),
  ).outcome,
  "csp-violations",
  "a policy refusal outranks the broken panel it may explain",
);
// And a broken panel outranks a console error: it is the control that does not work.
eq(
  judgeEmbedRender(seen({ panel: healthyPanel({ walks: false }), consoleErrors: ["boom"] })).outcome,
  "panel-broken",
  "a broken panel outranks an unrelated console error",
);

// ---------------------------------------------------------------------------
// Every outcome says something, and says it in Slate's voice
// ---------------------------------------------------------------------------

const byOutcome = new Map(
  [
    seen({ modalPresent: false }),
    seen({ loadFailedShown: true }),
    seen({ bookerMounted: false, frameText: "" }),
    seen({ bookerMounted: false, frameText: "This booking link is not available." }),
    seen({ consoleErrors: ["boom"] }),
    seen({ cspViolations: ["Refused to load the script because it violates the following Content Security Policy directive"] }),
    seen({ panel: healthyPanel({ walks: false }) }),
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


// ---------------------------------------------------------------------------
// #2565: a policy that breaks the embed fails SILENTLY from our side. The booker
// is in an iframe on a partner page, so the browser's refusal lands in a console
// nobody reads, and a lead meets a blank panel. This is the only signal that sees
// it, which is why it gets its own outcome rather than joining console errors.
// ---------------------------------------------------------------------------

eq(
  judgeEmbedRender(seen({ cspViolations: ["Refused to load the script 'https://x.test/a.js' because it violates the following Content Security Policy directive: \"script-src 'self'\""] })).outcome,
  "csp-violations",
  "a content security policy refusal is reported even though the booker drew",
);

// It must outrank console errors, because a CSP refusal is ALSO written to the
// console: asked in the other order this outcome could never fire, and a policy
// breaking the embed would read as an ordinary console error (L11).
eq(
  judgeEmbedRender(
    seen({
      cspViolations: ["Refused to load the script because it violates the following Content Security Policy directive"],
      consoleErrors: ["TypeError: something unrelated"],
    }),
  ).outcome,
  "csp-violations",
  "a policy refusal outranks an unrelated console error rather than being masked by it",
);

// And it must not fire on a healthy page, or it would be red from the day it
// shipped and stop being read (L36).
eq(judgeEmbedRender(seen()).outcome, "rendered", "no refusals means no policy finding");

// #2575: the policy is ENFORCED now, so a refusal is a part of the embed that did
// not load. The old wording ("report only, nothing is broken yet") would tell the
// reader an outage is a warning.
{
  const reason = judgeEmbedRender(
    seen({ cspViolations: ["Refused to load the script because it violates the following Content Security Policy directive"] }),
  ).reason;
  assert(reason.includes("enforced"), "the message says the policy is enforced, so the refusal really blocked something");
  assert(
    !reason.includes("report only") && !reason.includes("nothing is broken"),
    "the message no longer calls a real refusal a warning",
  );
}

// The predicate that routes a console line into that bucket, driven both ways.
assert(
  isCspRefusal("Refused to connect to 'https://x.test' because it violates the following Content Security Policy directive: \"connect-src 'self'\""),
  "a browser refusal line is recognised",
);
assert(
  isCspRefusal("[Report Only] Refused to load the script because it violates the following Content Security Policy directive"),
  "the report only variant is still recognised, though enforced refusals are what production produces",
);
assert(
  !isCspRefusal("TypeError: Cannot read properties of undefined"),
  "an ordinary error is not mistaken for a policy refusal",
);

finish();
