// Every form holding WORK warns before it is left, and no form holding a VIEW
// does (#1966).
//
// Dan asked for this swept across every form somebody can type into, so the
// judgement of which forms those are is the substance of the change and it is
// recorded here rather than in a sentence somebody has to trust.
//
// It is checked BOTH WAYS on purpose. A list of forms that must carry the guard
// only ever catches one being removed, and the failure this issue exists to
// prevent is a form nobody added it to. So the second half asserts that every
// form which holds editable state is in one of the two lists, which means a NEW
// form is a build failure until somebody decides which it is (L96: a guard
// driven by a hand written registry checks only what the registry lists).
//
// Run: node --experimental-strip-types scripts/test-unsaved-guard-coverage.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * WORK: state a person typed or chose that exists nowhere else, so leaving the
 * page loses it. Each one carries the guard.
 */
const WORK = [
  join("src", "components", "ui", "WorkingHoursForm.tsx"),
  join("src", "components", "ui", "BusinessHoursForm.tsx"),
  join("src", "components", "ui", "BusinessHoursExceptions.tsx"),
  join("src", "components", "ui", "OooForm.tsx"),
  join("src", "components", "ReasonOptionsEditor.tsx"),
];

/**
 * VIEW: state that holds nothing a person typed, so leaving costs a few
 * keystrokes or a reopened menu rather than work. Each one deliberately carries
 * no guard, and the reason matters: a warning that fires on a filter row or a
 * dropdown is the one people learn to click through, and then it is not
 * protecting the hours either (L36).
 */
const VIEW: Record<string, string> = {
  [join("src", "components", "ui", "SaveForm.tsx")]:
    "the form wrapper itself (#1994): its own state is whether the last save " +
    "died on a stale deploy and what was restored from the previous one, " +
    "neither of which anybody typed. It carries no guard because the form it " +
    "wraps carries its own, and two dialogs on one submit would be worse than " +
    "none",
  [join("src", "components", "admin", "RosterTable.tsx")]:
    "a filter row: which agents are listed, not anything about them",
  [join("src", "components", "BookingLookup.tsx")]:
    "a search box: the result is the point, the query is not",
  [join("src", "components", "ManageBooking.tsx")]:
    "the lead's own page, whose state is a chosen slot and a transient error " +
    "rather than typed work, and where a dialog mid booking would cost more " +
    "than it saves",
  // These four hold interaction state only: whether something is open, whether
  // a confirm is showing, how long a submit has been running. Nothing in any of
  // them was typed, so there is nothing to lose.
  [join("src", "components", "AccountMenu.tsx")]:
    "whether the account dropdown is open, which costs one click to reopen",
  [join("src", "components", "ui", "DeclineConfirm.tsx")]:
    "whether its inline confirm is showing, which is a step in an action rather " +
    "than a value",
  [join("src", "components", "ui", "RequestActions.tsx")]:
    "whether its inline confirm is showing; the request id beside it is a hidden " +
    "field, not something anybody typed",
  [join("src", "components", "ui", "SubmitButton.tsx")]:
    "how long the current submit has been running, which is meaningless once the " +
    "page is left",
};

const files = sources("src");
assert(files.length > 100, `the scanner found the app to judge (saw ${files.length} files)`);

const GUARD = /<UnsavedGuard\b/;
const guarded = files.filter((f) => GUARD.test(readFileSync(f, "utf8")));
// The guard's own file names the component and must not count as a call site.
const GUARD_FILE = join("src", "components", "ui", "UnsavedGuard.tsx");

// --- every form holding work carries it --------------------------------------
const missing = WORK.filter((f) => !guarded.includes(f));
assert(
  missing.length === 0,
  `every form holding unsaved work warns before it is left:\n    ${missing.join("\n    ")}`,
);

/**
 * What OPENS a form, in source.
 *
 * `<SaveForm>` renders a real `<form>` (#1994), so a guard inside one is inside
 * a form, and a component using one is a form-bearing component. Reading only
 * `<form` reported the working hours form as having no form at all the moment it
 * moved onto the wrapper, which is a check failing on a rename rather than on a
 * defect. Kept as one list, because two copies would drift the first time a
 * second wrapper appeared.
 */
const FORM_OPEN = /<(?:form|SaveForm)\b/g;
const FORM_CLOSE = /<\/(?:form|SaveForm)>/g;

// --- and it is INSIDE the form, or it guards nothing -------------------------
//
// The guard finds its own form by walking up from where it is rendered, so one
// mounted outside a `<form>` silently does nothing at all: it would render, pass
// every count, and warn about nothing.
const outside: string[] = [];
for (const f of guarded) {
  const text = readFileSync(f, "utf8");
  const beforeGuard = text.slice(0, text.search(GUARD));
  const opens = (beforeGuard.match(FORM_OPEN) ?? []).length;
  const closes = (beforeGuard.match(FORM_CLOSE) ?? []).length;
  if (opens <= closes) outside.push(f);
}
assert(
  outside.length === 0,
  `every guard sits inside the form it guards:\n    ${outside.join("\n    ")}`,
);

// --- nothing holding only a view carries it ----------------------------------
const overGuarded = Object.keys(VIEW).filter((f) => guarded.includes(f));
assert(
  overGuarded.length === 0,
  `a form that only decides what is being looked at does not warn:\n    ${overGuarded.join("\n    ")}`,
);

// --- and every form with editable state has been JUDGED ----------------------
//
// This is the half that catches a form nobody thought about. A component that
// holds React state AND renders a form is one somebody can type into, so it is
// either work or a view, and being in neither list is the state this issue was
// filed about.
const decided = new Set([...WORK, ...Object.keys(VIEW), GUARD_FILE]);
const unjudged: string[] = [];
for (const f of files) {
  if (decided.has(f)) continue;
  const text = readFileSync(f, "utf8");
  if (!/^"use client"/m.test(text)) continue;
  if (!new RegExp(FORM_OPEN.source).test(text)) continue;
  // A form with no local state submits whatever is typed straight away and holds
  // nothing across a navigation.
  if (!/\buseState[<(]/.test(text)) continue;
  unjudged.push(f);
}
assert(
  unjudged.length === 0,
  `every client form holding state is judged work or view:\n    ${unjudged.join("\n    ")}\n` +
    `    Add it to WORK (and mount <UnsavedGuard>) or to VIEW with the reason.`,
);

// --- the judgement carries its reasoning -------------------------------------
const thin = Object.entries(VIEW)
  .filter(([, why]) => why.trim().length < 30)
  .map(([f]) => f);
assert(
  thin.length === 0,
  `each view says WHY losing its state is not losing work: ${thin.join(", ")}`,
);

// --- both halves of the guard exist ------------------------------------------
//
// `beforeunload` covers a refresh, a close and the back button, and NOT a click
// on a link inside the app, which in an admin console is the commoner way to
// lose work. A version carrying only the browser half would pass a test that
// refreshed and leave the common case exactly as broken (L142: the observed half
// is usually the one you understand).
const guardSource = readFileSync(GUARD_FILE, "utf8");
assert(/beforeunload/.test(guardSource), "the browser half covers a refresh, a close and back");
assert(
  /addEventListener\("click", \w+, true\)/.test(guardSource),
  "the in app half intercepts a link click in the CAPTURE phase, before the router sees it",
);
assert(
  /stopPropagation/.test(guardSource),
  "and stops the event, since preventDefault alone leaves the client side navigation to proceed",
);

finish();
