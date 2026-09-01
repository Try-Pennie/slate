// Repo invariant (#1054): the skip link has something to skip TO on every page that
// shows it.
//
// `AppHeader` renders one skip link for every internal page, which is the right place
// for it (one header, one link). The consequence is that the TARGET lives in each
// page, and a skip link whose target is missing is worse than no skip link: it is a
// control that looks like it works, takes a tab stop, and moves focus nowhere. A
// keyboard user then presses it, nothing happens, and they learn to ignore it.
//
// Nothing else can catch that. tsc cannot see an anchor's target, the components
// render fine either way, and axe reports a valid link. So: every page rendering
// AppHeader must carry a `<main id="main">`, and the two halves must agree on the id,
// read out of the header rather than hardcoded here (a constant in this file would
// pass while the header pointed somewhere else).
//
// Run: node --experimental-strip-types scripts/test-skip-link-target.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const APP_DIR = "src/app";
const HEADER = "src/components/AppHeader.tsx";

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (entry === "page.tsx") out.push(path);
  }
  return out;
}

const header = readFileSync(HEADER, "utf8");

// --- the header's own half ---------------------------------------------------
const skipHref = header.match(/<a\s+href="#([A-Za-z0-9-]+)"\s+className="pn-skip-link"/);
assert(skipHref !== null, "AppHeader renders a skip link with a fragment target");
const targetId = skipHref?.[1] ?? "";
assert(targetId.length > 0, `the skip link names a target id (#${targetId})`);

// It has to be the FIRST focusable thing in the header's output, or it is not a skip
// link: a link that comes after the nav skips nothing.
const linkAt = header.indexOf('className="pn-skip-link"');
const firstNavAt = header.indexOf("<nav");
const firstButtonAt = header.indexOf("<button");
for (const [what, at] of [["nav", firstNavAt], ["button", firstButtonAt]] as const) {
  if (at !== -1) {
    assert(linkAt < at, `the skip link comes before the first ${what} in the header`);
  }
}

// The recipe has to exist, and has to be hidden until focused. A skip link that is
// permanently visible is a different (and unapproved) design decision, and one with
// no focus rule is invisible forever.
const css = readFileSync("src/app/globals.css", "utf8");
assert(css.includes(".pn-skip-link {"), "the skip link has a style recipe");
assert(css.includes(".pn-skip-link:focus {"), "and a focus rule that brings it on screen");

// --- every page that shows it carries the target -----------------------------
const all = pages(APP_DIR);
assert(all.length > 15, `read the app tree (${all.length} pages)`);

const withHeader = all.filter((p) => readFileSync(p, "utf8").includes("AppHeader"));
// The enumeration is the fragile half: a scan that found no pages reports the same
// empty result as a fully compliant tree (L98).
assert(
  withHeader.length >= 10,
  `found the pages that render the header (${withHeader.length})`,
);

const missing = withHeader.filter((p) => {
  const text = readFileSync(p, "utf8");
  return !new RegExp(`<main[^>]*\\sid="${targetId}"`).test(text);
});
assert(
  missing.length === 0,
  missing.length === 0
    ? `every page rendering AppHeader has a <main id="${targetId}">`
    : `no #${targetId} target, so the skip link moves focus nowhere: ${missing.join(", ")}`,
);

// Focus has to actually MOVE. Safari does not focus a non-focusable fragment target,
// so the target carries tabIndex={-1}: without it the link scrolls the page and
// leaves focus on the link, and the next tab goes back into the nav being skipped.
const notFocusable = withHeader.filter((p) => {
  const text = readFileSync(p, "utf8");
  const m = text.match(new RegExp(`<main[^>]*\\sid="${targetId}"[^>]*>`));
  return !m || !m[0].includes("tabIndex={-1}");
});
assert(
  notFocusable.length === 0,
  notFocusable.length === 0
    ? "and the target is focusable, so focus really moves there"
    : `the #${targetId} target is not focusable: ${notFocusable.join(", ")}`,
);

// --- positive control --------------------------------------------------------
// Strip the id from a real page's real text and require the same check to catch it,
// so this cannot rot into a scan that matches nothing.
{
  const victim = withHeader[0]!;
  const stripped = readFileSync(victim, "utf8").replace(`id="${targetId}"`, 'id="not-the-target"');
  eq(
    new RegExp(`<main[^>]*\\sid="${targetId}"`).test(stripped),
    false,
    "removing the target from a real page is caught by the same predicate",
  );
}

finish();
