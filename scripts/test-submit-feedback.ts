// Every submit says it started, and nothing new can ship without one (#1769).
//
// Eight files carried plain `<button>` elements inside server action forms, so a
// press changed nothing on screen until the response came back. Two of them were
// MIXED, meaning some buttons in the same component had been converted and others
// missed, which is how this erodes: it is a per site decision that nothing checks.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-submit-feedback.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { scanSubmitFeedback } from "./lib/scan-submit-feedback.ts";
import { assert, fail, finish } from "./lib/harness.ts";

// --- the tree ---
//
// Through the shared enumeration (#2421), which refuses a listing it cannot
// believe rather than reporting a clean tree over zero files. SubmitButton is
// the control itself, which is where the one raw submit belongs.
{
  const offenders = sourceFiles({
    match: /\.tsx$/,
    exclude: (f) => f.endsWith(".test.tsx") || f === "src/components/ui/SubmitButton.tsx",
  }).flatMap((f) => scanSubmitFeedback(f, readFileSync(f, "utf8")));
  if (offenders.length === 0) {
    assert(true, "every submit in src/ goes through SubmitButton");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
  }
}

// --- positive controls ---
//
// The defect is invisible by nature: a button that does nothing for a moment looks
// like a button that did nothing at all. So a green run above has to be worth
// something.
{
  const caught = (code: string, what: string) => {
    const hits = scanSubmitFeedback("fixture.tsx", code);
    assert(hits.length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanSubmitFeedback("fixture.tsx", code);
    assert(hits.length === 0, `allowed: ${what}${hits.length ? ` (wrongly flagged line ${hits[0].line})` : ""}`);
  };

  // The shape all six on the agent page had.
  caught(
    '<form action={setBookable}>\n  <button className={btnSecondaryCls}>Make bookable</button>\n</form>',
    "a bare button inside a server action form",
  );
  // The same thing with the attributes spread over lines, which is most of them.
  caught(
    '<form action={save}>\n  <button\n    className={btnCls}\n  >\n    Save\n  </button>\n</form>',
    "a bare button whose opening tag spans several lines",
  );
  // A submit written in a different file from its form.
  caught('<button type="submit" disabled={pending}>Yes, cancel</button>', "an explicit type=submit anywhere");
  caught("<button type={'submit'}>Go</button>", "an explicit submit written as an expression");

  // A GET form is a navigation: useFormStatus reports nothing for it.
  allowed(
    '<form method="GET" action="/admin/audit">\n  <button className={btnSecondaryCls}>Apply</button>\n</form>',
    "a button in a GET filter form",
  );
  allowed(
    '<form action="/search">\n  <button>Search</button>\n</form>',
    "a button in a form whose action is a URL string",
  );
  // Not a submit at all: a menu toggle, a disclosure, a cancel.
  allowed(
    '<form action={save}>\n  <button type="button" onClick={close}>Cancel</button>\n</form>',
    "an explicit type=button inside an action form",
  );
  allowed("<button type=\"button\" onClick={() => setOpen(true)}>Menu</button>", "a menu toggle");
  // Outside a form entirely, with no type: a plain control, not a submit.
  allowed("<button onClick={pick}>Choose</button>", "a bare button with no form around it");
  // The control itself.
  allowed(
    '<form action={save}>\n  <SubmitButton pendingLabel="Saving">Save</SubmitButton>\n</form>',
    "SubmitButton, which is the point",
  );
  // The form region closes, so a later button is not judged as being inside it.
  allowed(
    '<form action={save}>\n  <SubmitButton pendingLabel="Saving">Save</SubmitButton>\n</form>\n<button onClick={x}>Later</button>',
    "a bare button after the form has closed",
  );

  allowed(
    '<form action={save}>\n  {/* submit-feedback-ok: a no JavaScript fallback, and the page reloads */}\n  <button>Go</button>\n</form>',
    "an opt-out with a reason above it",
  );
  caught(
    '<form action={save}>\n  {/* submit-feedback-ok: */}\n  <button>Go</button>\n</form>',
    "an opt-out carrying no reason",
  );

  // #1998: THE WRAPPER IS A FORM.
  //
  // `<SaveForm>` renders a real `<form>` and takes a server action, so a plain
  // button inside one is the same defect as a plain button inside a `<form>`.
  // Reading only `<form` stopped seeing the agent page the moment its forms
  // moved onto the wrapper: the control below plants a button there and it went
  // uncaught, reporting the file clean. A check that stops MATCHING and a
  // converted tree produce the same empty list (L98).
  caught(
    '<SaveForm action={save} name="x">\n  <button className={btn}>Go</button>\n</SaveForm>',
    "a plain button inside the wrapper, which is a form",
  );
  allowed(
    '<SaveForm action={save} name="x">\n  <SubmitButton pendingLabel="Going">Go</SubmitButton>\n</SaveForm>',
    "a proper submit button inside the wrapper",
  );
  // And the region really CLOSES on the wrapper's own tag, or every plain button
  // after one would be judged as though it were still inside it.
  allowed(
    '<SaveForm action={save} name="x">\n  <SubmitButton pendingLabel="Going">Go</SubmitButton>\n</SaveForm>\n<button type="button" onClick={x}>Cancel</button>',
    "an ordinary button after the wrapper has closed",
  );

  // And the control that matters: put the REAL page's plain buttons back and
  // require this to catch them. A scanner that stopped matching and a converted
  // tree produce the same empty list (L98).
  const real = readFileSync("src/app/admin/agents/[id]/page.tsx", "utf8");
  const reverted = real.replace(
    '<SubmitButton className={btnSecondaryCls} pendingLabel="Setting role">Set role</SubmitButton>',
    "<button className={btnSecondaryCls}>Set role</button>",
  );
  assert(reverted !== real, "the overlay found its anchor in the real page");
  const hits = scanSubmitFeedback("src/app/admin/agents/[id]/page.tsx", reverted);
  assert(
    hits.length === 1 && /no type inside a server action form/.test(hits[0].why),
    `reverting one real button to a plain one is caught (${hits.length} findings)`,
  );
}

finish();
