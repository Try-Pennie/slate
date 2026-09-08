// Repo invariant (#1745): the internal pages' content width is decided in ONE place.
//
// It used to be decided in thirteen, each page hard coding its own cap on its own
// `<main>`, and they disagreed: `/me` at 672px, `/admin` at 896px,
// `/admin/bucket-availability` at 1152px. Two things came out of that. The admin
// home used about half of a wide window while the rest sat as empty margin, and
// moving between pages changed the content width underneath you. Neither is
// visible from any one page's source, which is why nothing caught it: every file
// looked like a deliberate choice.
//
// So: an internal page picks a width by naming a PageShell variant, never by
// writing a number. tsc cannot see this (a className is a string), and the pages
// render fine either way.
//
// Run: node --experimental-strip-types scripts/test-page-width.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { stripComments } from "./lib/strip-comments.ts";

const APP_DIR = "src/app";
const SHELL = "src/components/ui/PageShell.tsx";
/**
 * A LAYOUT can decide the width for every page beneath it, which is how the admin
 * console works since #1748: one content column around twenty section routes. It
 * still has to take that width from the shell's table rather than writing its own,
 * or "one place" quietly becomes two.
 */
const LAYOUTS = ["src/app/admin/layout.tsx", "src/app/me/layout.tsx"];

/**
 * The internal surfaces, and only those. The lead-facing pages (`/book`,
 * `/booking/[id]`) and `/login` are a different contract: they are full-bleed
 * centred layouts rather than a content column, and #1745 put them out of scope
 * by name. Named as a prefix list rather than "everything except", so a new
 * lead-facing page is not silently swept into a rule written for admin.
 */
const INTERNAL = ["src/app/admin", "src/app/me"];

/** A width written as a class, in either the Tailwind scale or an arbitrary value. */
const HARDCODED_WIDTH = /\bmax-w-(?:\[[^\]]+\]|\d*xl|xs|sm|md|lg|prose|screen-\w+|full|none|\d+)\b/;

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (entry === "page.tsx") out.push(path);
  }
  return out;
}

/**
 * EVERY opening `<main ...>` tag the file writes itself. Deliberately reads the
 * TAGS rather than the file: a `max-w-` anywhere else in a page is fine and often
 * right (a prose block, a card, a column inside a grid). It is only a defect on
 * the element that decides the page's own width.
 *
 * All of them, not the first: these pages open with an early-return deny notice
 * (`<main className="p-8 ...">`, no header, no content column) and the real
 * content `<main>` comes after it. A guard reading only the first tag inspects the
 * deny notice, finds no width, and reports the page clean however wide the second
 * one is hard coded to be (L135). The control below was written expecting exactly
 * that and caught this while it was still wrong.
 */
function mainTags(text: string): string[] {
  return [...stripComments(text).matchAll(/<main[^>]*>/gs)].map((m) => m[0]);
}


// --- the shell is the only place a page width is written ----------------------
const shell = readFileSync(SHELL, "utf8");
const widths = [...stripComments(shell).matchAll(/^\s*(\w+):\s*"(max-w-\[[^\]]+\])",?\s*$/gm)];
assert(
  widths.length === 2,
  widths.length === 2
    ? `${SHELL} offers exactly two widths (${widths.map((w) => w[1]).join(", ")})`
    : `${SHELL} offers ${widths.length} widths; a third recreates the problem this rule exists to fix`,
);

// --- no internal page writes its own -----------------------------------------
const internal = pages(APP_DIR).filter((p) => INTERNAL.some((d) => p.startsWith(d)));
// The enumeration is the fragile half: a scan that found no pages reports the same
// empty result as a fully compliant tree (L98).
assert(
  internal.length >= 12,
  `read the internal pages (${internal.length})`,
);

const offenders = internal.filter((p) =>
  mainTags(readFileSync(p, "utf8")).some((tag) => HARDCODED_WIDTH.test(tag)),
);
assert(
  offenders.length === 0,
  offenders.length === 0
    ? "no internal page sets its own content width"
    : `these set their own width instead of naming a PageShell variant: ${offenders.join(", ")}`,
);

// Each layout takes its width from the shell's table by NAME, never as a number.
// A layout is the one place a hard-coded cap would be invisible to the rule above,
// because it writes no `<main>` the pages own and nobody reads it looking for one.
const layoutDirs = LAYOUTS.map((l) => [l.replace(/\/layout\.tsx$/, "/"), l] as const);
for (const [, file] of LAYOUTS.map((l) => [null, l] as const)) {
  const text = stripComments(readFileSync(file, "utf8"));
  // Two legitimate ways to take the width from the shared table: name a variant
  // (the console builds its own three column row and needs the raw class) or
  // render the shell itself (which /me does, and which is the stronger form
  // because it also brings the skip link target with it).
  assert(
    /PAGE_WIDTHS\.\w+/.test(text) || /<PageShell[\s/>]/.test(text),
    `${file} takes its width from the shell rather than writing one`,
  );
  assert(
    !HARDCODED_WIDTH.test(text),
    `${file} writes no width of its own`,
  );
}

// And the pages really do reach one of those providers, or the rule above is
// satisfied by a tree with no `<main>` in it at all, which is a different bug
// wearing the same green.
const covered = internal.filter((p) => {
  const text = readFileSync(p, "utf8");
  return /<PageShell[\s/>]/.test(text) || layoutDirs.some(([dir]) => p.startsWith(dir));
});
assert(
  covered.length === internal.length,
  covered.length === internal.length
    ? `and every one of them gets its width from a shared provider (${covered.length})`
    : `these get their width from nowhere: ${internal.filter((p) => !covered.includes(p)).join(", ")}`,
);

// --- positive controls --------------------------------------------------------
{
  // 1. a real page reverts to a hard-coded cap. Built from the REAL shell's own
  //    markup so the fixture is the thing that would actually be written back.
  const shellMain = mainTags(shell)[0];
  assert(shellMain !== undefined, "the shell writes the <main> the pages used to write");
  // #2103: the pages themselves stopped rendering the shell when /me got a
  // layout, so this control now reverts whatever DOES render it, page or layout.
  // Pinning it to a page would have made the control unsatisfiable and the
  // honest reading of that red is "there is nothing left to revert", which is a
  // guard reporting on itself rather than on the tree.
  const viaShell = [...internal, ...LAYOUTS].filter((p) =>
    /<PageShell[\s/>]/.test(readFileSync(p, "utf8")),
  );
  assert(viaShell.length >= 1, `something still renders the shell directly (${viaShell.length})`);
  const reverted = readFileSync(viaShell[0]!, "utf8").replace(
    /<PageShell[^>]*>/,
    shellMain!.replace("${PAGE_WIDTHS[width]}", "max-w-4xl").replace(/[{}`]/g, ""),
  );
  eq(
    mainTags(reverted).some((t) => HARDCODED_WIDTH.test(t)),
    true,
    "a page that writes its own max-width again is caught",
  );

  // 1b. and it is caught on a LATER <main>, not only the first one in the file.
  //
  //     Synthetic, deliberately, and worth saying why. When this guard was written
  //     every internal page opened with an early-return deny notice
  //     (`<main className="p-8 ...">`) and put its content `<main>` after it, so a
  //     scan reading only the first tag inspected the deny notice, found no width,
  //     and reported the page clean however wide the second one was hard coded to
  //     be. #1748 removed those early returns, so no page in the tree has two
  //     `<main>` tags today and the real-text version of this control cannot be
  //     built any more. That is exactly the moment a guard quietly stops covering
  //     the thing it was written for, so the fixture stays and states its own
  //     provenance rather than the rule being relaxed to match the current tree.
  const twoMains =
    '<main className="p-8 text-sm text-fg-muted">no access</main>' +
    '\n<main id="main" className="mx-auto w-full max-w-4xl">content</main>';
  eq(
    mainTags(twoMains).findIndex((tag) => HARDCODED_WIDTH.test(tag)),
    1,
    "a width on a later <main> is caught, not just one on the first",
  );

  // 2. the rule must not fire on a width that is NOT the page's own, or every
  //    prose block and card would read as a violation and the guard would be
  //    turned off rather than fixed.
  const proseInside = "<main className=\"mx-auto w-full\"><p className=\"max-w-[65ch]\">hi</p></main>";
  eq(
    mainTags(proseInside).some((t) => HARDCODED_WIDTH.test(t)),
    false,
    "a max-width on a prose block inside the page is not a violation",
  );

  // 3. a third variant in the shell is caught, since that is how "one place"
  //    quietly becomes "thirteen places, one indirection along".
  const threeWidths = [
    ...stripComments(shell)
      .replace('} as const;', '  extra: "max-w-[60rem]",\n} as const;')
      .matchAll(/^\s*(\w+):\s*"(max-w-\[[^\]]+\])",?\s*$/gm),
  ];
  eq(threeWidths.length, 3, "a third width added to the shell is counted");
}

finish();
