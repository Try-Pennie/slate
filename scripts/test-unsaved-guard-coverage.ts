// Nothing a person types is lost by clicking a link (#2076). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-unsaved-guard-coverage.ts
//
// WHAT HAPPENED. Dan changed fourteen alert floors on /admin/alerts, navigated
// away, and lost every one of them with no warning. His words: "I should never be
// able to lose something I typed by going to another page."
//
// The guard already existed and worked. It was OPT IN, and five of sixteen
// `SaveForm` call sites had taken it, which is the shape L613 describes exactly: a
// shared component made to end N copies gets applied to the cluster in front of
// whoever built it, and the rest stand with nothing to report them.
//
// SO THE FIX IS OWNERSHIP, AND THIS FILE IS ONLY THE OTHER HALF. `SaveForm` mounts
// the guard itself and takes a required `unsaved` prop, so `tsc` enumerates every
// construction site and a new one cannot be silent (L621). What is left for a scan
// is the structural question: a raw `<form>` holding a control somebody types
// into, with nothing guarding it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanUnsavedGuard } from "./lib/scan-unsaved-guard.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the scanner's own rules, over fixtures ------------------------------------

{
  const found = scanUnsavedGuard("f.tsx", `<form action={a}>\n  <input name="x" />\n</form>`);
  eq(found.length, 1, "a raw form with a text input and no guard is reported");
}
{
  const found = scanUnsavedGuard(
    "f.tsx",
    `<form action={a}>\n  <UnsavedGuard what="changes" />\n  <input name="x" />\n</form>`,
  );
  eq(found.length, 0, "one that mounts the guard is not");
}
{
  const found = scanUnsavedGuard(
    "f.tsx",
    `// unsaved-ok: a filter row holds a view, not work\n<form method="GET">\n  <input name="q" />\n</form>`,
  );
  eq(found.length, 0, "and neither is one whose opt out carries a reason");
}
{
  const found = scanUnsavedGuard("f.tsx", `// unsaved-ok:\n<form method="GET">\n  <input name="q" />\n</form>`);
  eq(found.length, 1, "an opt out with NO reason is not an opt out (L233)");
}
{
  // The JSX form of the same emptiness, which the first version of this accepted:
  // the comment's own terminator is a non-space character, so it read as a reason
  // (#2112, found by writing the same rule again for marks).
  const found = scanUnsavedGuard(
    "f.tsx",
    `{/* unsaved-ok: */}\n<form method="GET">\n  <input name="q" />\n</form>`,
  );
  eq(found.length, 1, "and neither is an empty one in a JSX comment");
}
{
  // The form it actually has to be written on is JSX, where `//` is not a comment
  // and the only way to say anything is a `{/* ... */}` block. A convention that
  // read only `//` would be one nobody could obey where it is needed.
  const found = scanUnsavedGuard(
    "f.tsx",
    `{/* unsaved-ok: a filter row holds a view, not work */}\n<form method="GET">\n  <input name="q" />\n</form>`,
  );
  eq(found.length, 0, "the opt out is recognised in a JSX comment, which is where it has to live");
}
{
  // A confirm strip: hidden fields and buttons only. Nothing is typed into it, so
  // there is nothing to lose and no exception has to be written for it.
  const found = scanUnsavedGuard(
    "f.tsx",
    `<form action={a}>\n  <input type="hidden" name="id" value={id} />\n  <button type="submit">Cancel this</button>\n</form>`,
  );
  eq(found.length, 0, "a form of hidden fields and buttons is silent with no exception written for it");
}
{
  for (const control of ['<textarea name="note" />', '<select name="k"><option>a</option></select>', '<input type="search" name="q" />']) {
    const found = scanUnsavedGuard("f.tsx", `<form action={a}>\n  ${control}\n</form>`);
    eq(found.length, 1, `${control.slice(0, 12)} counts as somewhere work can be typed`);
  }
}

{
  // The shape three of the real forms are written in, and the shape the first
  // version of this scanner missed every one of: a multi line JSX form opens with
  // `<form` and nothing else on the line.
  const found = scanUnsavedGuard(
    "f.tsx",
    `<form\n  action={a}\n  className="x"\n>\n  <input name="x" />\n</form>`,
  );
  eq(found.length, 1, "a form whose opening tag spans lines is still found");
}

// --- the real tree --------------------------------------------------------------

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsxFiles(path));
    } else if (path.endsWith(".tsx") && !path.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

const files = tsxFiles("src");
assert(files.length > 50, `the tree was actually walked (found ${files.length} files)`);

const unguarded = files.flatMap((f) => scanUnsavedGuard(f, readFileSync(f, "utf8")));
eq(
  unguarded.map((u) => `${u.file}:${u.line}`),
  [],
  "every hand written form that can hold typed work either guards it or says why not",
);

// THE POSITIVE CONTROL. A scanner that matched nothing at all would report this
// same empty list, so it has to be shown catching a real instance: the alerts page
// is what Dan lost his work on, and this is that form with its guard taken away
// and written by hand (L1).
{
  const planted = `export function Alerts() {
  return (
    <form action={setMonitorSettings} className="space-y-8">
      <input name="booking_failure_rate_pct" defaultValue={20} />
      <button type="submit">Save</button>
    </form>
  );
}`;
  const found = scanUnsavedGuard("src/app/admin/alerts/page.tsx", planted);
  eq(found.length, 1, "the scanner catches the very form this issue was opened about");
}

finish();
