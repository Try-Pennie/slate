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

const APP_DIR = "src/app";
const SHELL = "src/components/ui/PageShell.tsx";

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

/**
 * Comments out, before anything looks for markup. Both of these files EXPLAIN
 * themselves by naming the thing they are about: PageShell's own doc comment
 * contains a literal `<main>` and the words `max-w-4xl`, and so does this file.
 * Scanning the raw text picks the prose up as markup, so the shell's "tag" comes
 * back as the four characters in a sentence and every verdict built on it is about
 * a comment (L135, L103, and the reason a check on a whole file is satisfied by
 * any occurrence in it). Two of the controls below were written before this and
 * failed on exactly that.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

// And they really do reach the shell, or the rule above is satisfied by a tree
// with no `<main>` in it at all, which is a different bug wearing the same green.
const viaShell = internal.filter((p) =>
  /<PageShell[\s/>]/.test(readFileSync(p, "utf8")),
);
assert(
  viaShell.length >= 12,
  `and they get their width from the shell (${viaShell.length} of ${internal.length})`,
);

// --- positive controls --------------------------------------------------------
{
  // 1. a real page reverts to a hard-coded cap. Built from the REAL shell's own
  //    markup so the fixture is the thing that would actually be written back.
  const shellMain = mainTags(shell)[0];
  assert(shellMain !== undefined, "the shell writes the <main> the pages used to write");
  const reverted = readFileSync(viaShell[0]!, "utf8").replace(
    /<PageShell[^>]*>/,
    shellMain!.replace("${PAGE_WIDTHS[width]}", "max-w-4xl").replace(/[{}`]/g, ""),
  );
  eq(
    mainTags(reverted).some((t) => HARDCODED_WIDTH.test(t)),
    true,
    "a page that writes its own max-width again is caught",
  );

  // 1b. and it is caught on the SECOND <main>, which is where it would land: the
  //     deny notice comes first and never carries a width.
  eq(
    mainTags(reverted).findIndex((t) => HARDCODED_WIDTH.test(t)) > 0,
    true,
    "caught on the content <main>, not on the deny notice that precedes it",
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
