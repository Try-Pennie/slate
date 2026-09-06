// #1994: a new staff form cannot go back to posting straight at a server action.
//
// A browser submitting a server action names it by an id minted at BUILD time.
// When a deploy lands under a page somebody already has open, that name is gone,
// Next replies 404, and a plain `<form action={serverAction}>` with nothing
// catching it reaches the error boundary saying it cannot tell what happened.
// `SaveForm` recognises exactly that failure, says nothing was saved, and puts
// back what was typed after the reload it asks for.
//
// The wrapper is on the working hours form, which is the one Dan lost two saves
// on in a morning and the one 121 agents are filling in during the parallel run.
// The migration of the rest is #1998, and the list below is what is left. This
// guard is what stops it GROWING while that happens: a new form must use the
// wrapper, or be added here deliberately, and an entry that has moved must be
// deleted rather than left standing.
//
// Run: node --experimental-strip-types scripts/test-save-form-coverage.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";

/**
 * Components that still post straight at a server action, and the issue that
 * moves them.
 *
 * ONE shared reason rather than twenty written out, because it really is one
 * reason: none of them has been migrated yet. An entry carrying its own excuse
 * would be the thing L233 warns about in reverse, prose invented to satisfy a
 * format. Delete an entry as it moves; #1998 has the order and why they are not
 * all the same job.
 */
const STILL_POSTING_DIRECTLY = new Set(
  [
    "src/app/admin/agents/[id]/page.tsx",
    "src/app/admin/agents/page.tsx",
    "src/app/admin/business-hours/page.tsx",
    "src/app/admin/ooo/page.tsx",
    "src/app/admin/webhooks/page.tsx",
    "src/app/me/page.tsx",
    "src/components/AccountMenu.tsx",
    "src/components/AppHeader.tsx",
    "src/components/TeamAccessPanel.tsx",
    "src/components/admin/ViewAsButton.tsx",
    "src/components/admin/WebhookTestSend.tsx",
    "src/components/ui/BusinessHoursExceptions.tsx",
    "src/components/ui/BusinessHoursForm.tsx",
    "src/components/ui/OooForm.tsx",
    "src/components/ui/RequestActions.tsx",
    // The wrapper itself renders the `<form>` every migrated component uses.
    "src/components/ui/SaveForm.tsx",
  ].map((p) => join(...p.split("/"))),
);

/** A `<form action={someIdentifier}>`: posting at a server action rather than at
 *  a URL. `action="/somewhere"` is a string and is not this. */
const DIRECT_POST = /<form[^>]*\baction=\{([A-Za-z_$][\w$.]*)\}/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const files = [...walk("src/components"), ...walk("src/app")];
assert(files.length > 40, `the scanner found the app to judge (${files.length} files)`);

const offenders: string[] = [];
let seen = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const matches = [...text.matchAll(new RegExp(DIRECT_POST.source, "g"))];
  if (matches.length === 0) continue;
  seen++;
  if (!STILL_POSTING_DIRECTLY.has(f)) offenders.push(`${f} (${matches.map((m) => m[1]).join(", ")})`);
}

if (offenders.length) {
  fail(
    `a form posts straight at a server action, so a deploy landing under it ` +
      `kills the save with no explanation. Use <SaveForm>, or add it to ` +
      `STILL_POSTING_DIRECTLY with #1998:\n    ${offenders.join("\n    ")}`,
  );
} else {
  assert(true, "no new form posts straight at a server action");
}

// The list is not allowed to hold names that are not there any more: a stale
// entry is a permanent exemption for a file nobody can find, and it makes the
// list read as longer than the work actually left.
{
  const present = new Set(files);
  const gone = [...STILL_POSTING_DIRECTLY].filter((f) => !present.has(f));
  assert(gone.length === 0, `every listed component still exists:\n    ${gone.join("\n    ")}`);
}

// AND THE LIST SHRINKS RATHER THAN STANDING. An entry that has been migrated but
// left here is a file the guard stops judging, so the next form added to it is
// exempt from the rule it was exempted from for a reason that has gone.
{
  const migrated = [...STILL_POSTING_DIRECTLY].filter((f) => {
    const text = readFileSync(f, "utf8");
    return !new RegExp(DIRECT_POST.source).test(text) && f !== join("src", "components", "ui", "SaveForm.tsx");
  });
  assert(
    migrated.length === 0,
    `these no longer post directly and should be removed from the list:\n    ${migrated.join("\n    ")}`,
  );
}

// The one that is migrated really is. Without this the whole guard could pass
// over an app where nothing uses the wrapper at all (L98).
{
  const hours = readFileSync(join("src", "components", "ui", "WorkingHoursForm.tsx"), "utf8");
  assert(/<SaveForm\b/.test(hours), "the working hours form goes through the wrapper");
  assert(
    !new RegExp(DIRECT_POST.source).test(hours),
    "and does not also post directly",
  );
  assert(
    !STILL_POSTING_DIRECTLY.has(join("src", "components", "ui", "WorkingHoursForm.tsx")),
    "and is not listed as unmigrated",
  );
}

// A positive control on the detector: the shape it hunts is really matched, and
// a form posting at a URL is not.
{
  assert(
    new RegExp(DIRECT_POST.source).test('<form action={setWorkingHours} className="x">'),
    "the detector matches a form posting at a server action",
  );
  assert(
    !new RegExp(DIRECT_POST.source).test('<form action="/api/thing" method="post">'),
    "and not one posting at a URL",
  );
  assert(
    !new RegExp(DIRECT_POST.source).test("<SaveForm action={setWorkingHours}>"),
    "and not the wrapper itself",
  );
}

assert(seen > 5, `the rule has subjects (${seen} components post at a server action)`);

/**
 * The opening tag of each `<SaveForm ...>` in a file.
 *
 * SCANNED to the closing `>` at brace depth zero rather than taken as a fixed
 * number of characters from the tag. The first version took 700, and the booker
 * copy form's tag is 911 because it carries an explanatory comment inside it: a
 * check that reads a fixed span from an anchor stops containing the thing it
 * checks the moment a comment is added (L518), and it failed by finding NOTHING,
 * which is the direction that reads as a clean tree.
 */
function saveFormTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<SaveForm\b/g)) {
    let depth = 0;
    for (let i = (m.index ?? 0) + "<SaveForm".length; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        out.push(src.slice(m.index ?? 0, i + 1));
        break;
      }
    }
  }
  return out;
}

// --- a repeated form needs a name PER INSTANCE ------------------------------
//
// The stash a save is kept in is keyed by the page path and the form's name. A
// form rendered once per row with one FIXED name files every instance under one
// key, so a save killed by a deploy restores one row's values into another
// row's fields, which is worse than restoring nothing.
//
// Caught on the booker copy page, which renders one form per event type.
//
// "IS IT IN A LIST" IS ASKED OF `key`, not of the surrounding source. The first
// version looked back for an unclosed `.map(` and counted brackets, and reported
// the buckets page, whose form is not in a list at all: an earlier
// `users.map((u) => ({ ... }))` left its count unbalanced. React already
// requires `key` on exactly the elements this rule is about, so that is the
// signal, and no bracket elsewhere in the file can confuse it.
{
  const bad: string[] = [];
  let tagsSeen = 0;
  for (const f of files) {
    for (const tag of saveFormTags(readFileSync(f, "utf8"))) {
      tagsSeen++;
      if (!/\bname=/.test(tag)) {
        bad.push(`${f}: a SaveForm with no name at all`);
        continue;
      }
      if (!/\bkey=/.test(tag)) continue; // not rendered in a list
      if (!/name=\{`[^`]*\$\{/.test(tag)) {
        bad.push(`${f}: <SaveForm> has a key, so it is one of several, but its name is fixed`);
      }
    }
  }
  assert(
    bad.length === 0,
    `a repeated form files every instance under one key:\n    ${bad.join("\n    ")}`,
  );

  // Controls, because a rule that matched nothing would read the same as a clean
  // tree, and the first version of the scan really did match nothing.
  assert(tagsSeen > 3, `the scan found SaveForm tags to judge (${tagsSeen})`);
  const keyed = saveFormTags(
    readFileSync(join("src", "app", "admin", "booker-copy", "page.tsx"), "utf8"),
  ).filter((t) => /\bkey=/.test(t));
  assert(keyed.length > 0, "the keyed form the rule was written for is still there");
  assert(/name=\{`[^`]*\$\{/.test(keyed[0]!), "and its name varies per instance");
}

finish();
