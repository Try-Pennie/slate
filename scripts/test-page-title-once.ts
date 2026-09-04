// A console page names itself ONCE (#1915).
//
// Dan on /admin/routing: "this is redundant". The page header said `Recent
// routing` with a description, and the card immediately below said `Recent
// routing` with almost the same description.
//
// It was five pages, not one, and the reason is worth stating: a page shell that
// provides a title and a description is correct on its own, and a section that
// describes itself is correct on its own. The duplication exists only in the
// COMPOSITION, which is the one place nobody reads. It bites hardest on a page
// whose whole content is one section, because then the page and the section
// genuinely are the same thing.
//
// So this compares each page's `AdminPageHeader title` against every `<h2>` in
// the same file, which is how the five were found.
//
// WHAT IT CANNOT SEE, stated here so nobody reads it as broader coverage than it
// has: a heading rendered by a COMPONENT the page mounts. #1907 was exactly that
// (the Team access panel titled itself while its page did too) and was found by
// eye, not by this. A page whose sections all live in components is invisible to
// this scan.
// Run: node --experimental-strip-types scripts/test-page-title-once.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

/** Source with the prose blanked, keeping any line that carries the opt-out. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) =>
      m.includes("title-twice-ok:") ? m : m.replace(/[^\n]/g, " "),
    )
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) && !line.includes("title-twice-ok:") ? "" : line))
    .join("\n");
}

const offenders: string[] = [];
let scanned = 0;
for (const file of pages(join("src", "app", "admin"))) {
  const text = code(readFileSync(file, "utf8"));
  const title = text.match(/AdminPageHeader\s+title="([^"]+)"/)?.[1];
  if (!title) continue;
  scanned += 1;
  if (/title-twice-ok:/.test(text)) continue;

  for (const m of text.matchAll(/<h2[^>]*>\s*([^<{]+?)\s*<\/h2>/g)) {
    if (m[1].trim().toLowerCase() === title.trim().toLowerCase()) {
      const at = text.slice(0, m.index).split("\n").length;
      offenders.push(`${file}:${at} "${title}" is both the page title and a section heading`);
    }
  }
}

assert(
  offenders.length === 0,
  `no console page states its own title twice:\n    ${offenders.join("\n    ")}`,
);

// An empty offender list and a scanner that matched no page render the same
// (L98), so the count of pages it actually judged is asserted too.
assert(
  scanned >= 10,
  `the scanner found console pages with a header to judge (saw ${scanned})`,
);

finish();
