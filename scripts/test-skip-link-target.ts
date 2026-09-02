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
import { stripComments } from "./lib/strip-comments.ts";

const APP_DIR = "src/app";
const HEADER = "src/components/AppHeader.tsx";
const SHELL = "src/components/ui/PageShell.tsx";
/** A page reaches the shared target by rendering the shell, in either form. */
const SHELL_USE = /<PageShell[\s/>]/;
/**
 * A LAYOUT can provide the header and the target for every page beneath it, which
 * is how the admin console works since #1748: one header and one `<main>` around
 * twenty section routes. So the two questions this file asks are answered per
 * page by whichever provider covers it, and a page under such a layout carries
 * neither itself.
 */
const LAYOUTS = ["src/app/admin/layout.tsx"];

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

/** Every file that can PROVIDE the target: the shell, and each layout. */
const providers = [SHELL, ...LAYOUTS];

// --- everything that provides the target really provides one -----------------
// #1745: the target used to be repeated on every page, because every page also
// carried its own hard-coded max-width on the same `<main>`. Both moved into
// PageShell, so this guard follows it there. The page-level check below then asks
// a slightly different question, and the two halves are blind where each other
// looks: this half proves the shell really renders a focusable target, and that
// half proves each page actually reaches the shell.
/**
 * The rendered `<main id>` tag, if the file writes one. Comments are stripped
 * first: a file that renders this tag almost always also NAMES it in a doc
 * comment explaining why, the comment comes first, and matching that reports a
 * correct file as having a non-focusable target (see ./lib/strip-comments.ts).
 */
const mainTag = (text: string) =>
  stripComments(text).match(new RegExp(`<main[^>]*\\sid="${targetId}"[^>]*>`, "s"));

for (const file of providers) {
  const tag = mainTag(readFileSync(file, "utf8"));
  assert(
    tag !== null,
    tag !== null
      ? `${file} renders the <main id="${targetId}"> the pages beneath it skip to`
      : `${file} no longer renders a #${targetId} target, so every page it covers has none`,
  );
  // Safari does not focus a non-focusable fragment target, so without this the
  // link scrolls the page and leaves focus on the link, and the next tab goes
  // back into the nav being skipped.
  assert(
    (tag?.[0] ?? "").includes("tabIndex={-1}"),
    `and ${file}'s target is focusable, so focus really moves there`,
  );
}
const shell = readFileSync(SHELL, "utf8");
const shellMain = mainTag(shell);

// --- every page that shows it carries the target -----------------------------
const all = pages(APP_DIR);
assert(all.length > 15, `read the app tree (${all.length} pages)`);

/** The directories each layout covers, with the layout that covers them. */
const layoutDirs = LAYOUTS.map((l) => [l.replace(/\/layout\.tsx$/, "/"), l] as const);
const layoutFor = (page: string) =>
  layoutDirs.find(([dir]) => page.startsWith(dir))?.[1] ?? null;

// Each layout that claims to render the header must actually render one, or the
// pages beneath it are counted as covered by nothing.
for (const [, file] of layoutDirs) {
  assert(
    readFileSync(file, "utf8").includes("AppHeader"),
    `${file} renders the header for the pages beneath it`,
  );
}

const withHeader = all.filter(
  (p) => readFileSync(p, "utf8").includes("AppHeader") || layoutFor(p) !== null,
);
// The enumeration is the fragile half: a scan that found no pages reports the same
// empty result as a fully compliant tree (L98).
assert(
  withHeader.length >= 10,
  `found the pages that render the header (${withHeader.length})`,
);

/**
 * A page has a target if it renders the shell that provides one, or if it still
 * carries its own focusable `<main id>`. Both are accepted because a page is free
 * to render its own `<main>` (the standalone lead-facing ones do), and a check
 * that demanded the shell would be a check on how the page is built rather than on
 * whether the skip link lands anywhere.
 */
function targetFor(page: string, text: string): "layout" | "shell" | "own" | null {
  if (layoutFor(page) !== null) return "layout";
  if (SHELL_USE.test(text)) return "shell";
  const own = mainTag(text);
  if (own && own[0].includes("tabIndex={-1}")) return "own";
  return null;
}

const missing = withHeader.filter((p) => targetFor(p, readFileSync(p, "utf8")) === null);
assert(
  missing.length === 0,
  missing.length === 0
    ? `every page rendering AppHeader reaches a focusable #${targetId}`
    : `no #${targetId} target, so the skip link moves focus nowhere: ${missing.join(", ")}`,
);

// Worth stating as its own measurement rather than leaving it implied: if NOTHING
// went through the shell, the shell half above would be checking a component no
// page renders, and this file would be green while proving nothing about the
// pages (L98).
const shared = withHeader.filter((p) => {
  const how = targetFor(p, readFileSync(p, "utf8"));
  return how === "shell" || how === "layout";
});
assert(
  shared.length >= 10,
  `and most of them reach it through a shared provider (${shared.length} of ${withHeader.length})`,
);
const viaShell = withHeader.filter(
  (p) => targetFor(p, readFileSync(p, "utf8")) === "shell",
);
assert(
  viaShell.length >= 1,
  `at least one page still reaches it through ${SHELL} directly (${viaShell.length}), so the shell half above is not checking a component nothing renders`,
);

// --- positive controls -------------------------------------------------------
// Each way the target can be lost, planted in REAL text and required to be caught,
// so this cannot rot into a scan that matches nothing.
{
  // Damage the MATCHED TAG, never the first textual occurrence in the file. The
  // shell's own doc comment names `id="main"` and `tabIndex={-1}` while explaining
  // why they are there, so a plain `.replace` edits the prose and leaves the real
  // tag standing: the control then reports the check as blind when the check is
  // fine, which is the same class of mistake it exists to catch (L135). This was
  // not hypothetical; both controls below failed exactly that way when written.
  const damage = (from: string, to: string) =>
    shell.replace(shellMain![0], shellMain![0].replace(from, to));

  // 1. the shell stops providing the target, which breaks every page at once.
  const stripped = damage(`id="${targetId}"`, 'id="not-the-target"');
  eq(
    new RegExp(`<main[^>]*\\sid="${targetId}"`).test(stripped),
    false,
    "removing the target from the shell is caught by the same predicate",
  );

  // 2. the shell keeps the id but stops being focusable, which is the subtler
  //    half: the link would scroll and leave focus behind in the nav.
  const unfocusable = damage("tabIndex={-1}", "");
  const m = unfocusable.match(new RegExp(`<main[^>]*\\sid="${targetId}"[^>]*>`, "s"));
  eq(
    (m?.[0] ?? "").includes("tabIndex={-1}"),
    false,
    "removing tabIndex from the shell is caught too",
  );

  // 3. one page stops reaching the shell and has no target of its own.
  const victim = viaShell[0]!;
  const orphaned = readFileSync(victim, "utf8").replace(/<PageShell/g, "<div");
  eq(
    targetFor(victim, orphaned),
    null,
    "a page that stops rendering the shell and has no <main> of its own is caught",
  );

  // 4. a layout stops providing one, which silently orphans every page under it
  //    while each of those pages still reads as perfectly fine on its own.
  for (const [dir, file] of layoutDirs) {
    const covered = withHeader.filter((p) => p.startsWith(dir));
    assert(covered.length > 0, `${file} actually covers pages (${covered.length})`);
    const layoutText = readFileSync(file, "utf8");
    const tag = mainTag(layoutText)![0];
    const broken = stripComments(layoutText).replace(
      tag,
      tag.replace(`id="${targetId}"`, 'id="gone"'),
    );
    eq(
      mainTag(broken),
      null,
      `removing the target from ${file} is caught, so its pages are not silently orphaned`,
    );
  }
}

finish();
