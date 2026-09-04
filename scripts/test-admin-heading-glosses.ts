// A heading either names its thing or it does not (#1901).
//
// Three admin headings explained their own jargon in brackets rather than being
// named: `Buckets (round-robin pools)`, `Bookable agents (available today)` and
// `Code (xbc)`. Each is a label that did not survive being read by somebody who
// had not written it, so a gloss was appended instead of the label being fixed.
// The bracket is the tell.
//
// It costs more than it looks: a bracketed gloss is read on every view by
// everybody, forever, to serve the one reader who needed it once. Where the
// explanation is genuinely needed it belongs somewhere reachable rather than
// somewhere it must be passed through, which is the pattern already in the repo
// at RosterTable's Team column (#1812): a `title` plus an `sr-only` span.
//
// THREE INSTANCES IS A CONVENTION, NOT A COINCIDENCE, which is why this exists
// rather than the three being fixed and the pattern left with no owner. A guard
// on a hand written list of three files would check only those three (L96), so
// this scans every heading in the admin surface.
//
// WHAT A BRACKET IS LEGITIMATELY FOR, and the reason this needs an opt-out
// rather than a blanket ban: a UNIT (`Alert cooldowns (minutes)`), a COUNT
// (`Couldn't place (3)`), OPTIONALITY (`... (optional)`), a PLURAL (`Debt
// team(s)`) and the SCOPE of a value (`Description (shown to lead ...)`) are all
// bracketed and none is a gloss. Those carry `heading-gloss-ok: <why>`, in the
// same shape as this repo's other conventions, so the exemption is a stated
// reason rather than a path nobody revisits.
// Run: node --experimental-strip-types scripts/test-admin-heading-glosses.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOTS = [join("src", "app", "admin"), join("src", "components", "admin")];

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
 * Source with the prose removed, keeping the lines that carry the opt-out.
 *
 * These files QUOTE the headings they fixed while explaining why, so scanning
 * the raw text finds the explanation and reports a heading that is not there
 * (L361). Block comments are blanked IN PLACE so line numbers survive.
 *
 * A comment carrying the opt-out marker survives either way. That is not a
 * detail: in a `.tsx` file a comment beside JSX is written `{/* ... *\/}`, which
 * is a BLOCK comment, so stripping every block comment wipes every exemption and
 * the guard then reports the sites it was told about. It did exactly that on the
 * first run.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) =>
      m.includes("heading-gloss-ok:") ? m : m.replace(/[^\n]/g, " "),
    )
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) && !line.includes("heading-gloss-ok:") ? "" : line))
    .join("\n");
}

/** A heading, a column header, an eyebrow or a field label: the things a reader
 *  scans rather than reads. */
/**
 * `labelCls\}[^>]*>` rather than `labelCls\}>`, and that is not tidying. The
 * first version required the tag to END at the class, so a label carrying any
 * other attribute was invisible to it: `<span className={labelCls} id={...}>`
 * was silently unscanned, and a gloss written that way would have been exempt
 * from the guard meant to catch it (L96).
 */
const HEADING =
  /(?:<h[1-3][^>]*>|<th[^>]*>|pn-eyebrow[^>]*>|labelCls\}[^>]*>)\s*([^<{]*\([^)]*\)[^<{]*)/g;

const offenders: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const file of sources(root)) {
    const text = code(readFileSync(file, "utf8"));
    const lines = text.split("\n");
    for (const m of text.matchAll(HEADING)) {
      scanned += 1;
      const at = text.slice(0, m.index).split("\n").length;
      const above = lines.slice(Math.max(0, at - 5), at).join("\n");
      if (/heading-gloss-ok:/.test(above) || /heading-gloss-ok:/.test(lines[at - 1] ?? "")) continue;
      offenders.push(`${file}:${at} ${m[1].trim()}`);
    }
  }
}

assert(
  offenders.length === 0,
  `every bracketed heading is a unit, a count or a stated exemption:\n    ${offenders.join("\n    ")}`,
);

// The scanner has to be able to SEE a bracketed heading, or an empty offender
// list is indistinguishable from a scanner that matched nothing (L98). The
// exempted ones are that control: they exist, they were found, and each was let
// through by a reason rather than by the pattern missing them.
assert(scanned > 0, "the scanner found bracketed headings to judge at all");

// --- the definition that MOVED is reachable, not hover only ------------------
//
// WCAG 2.1: a `title` alone is not available on touch, is not announced by
// every screen reader, and vanishes when the pointer moves. The definition lives
// in one constant read by both, so the visible pointer and the announced text
// cannot drift.
{
  const tiers = readFileSync(join("src", "app", "admin", "tiers", "page.tsx"), "utf8");
  const legend = tiers.match(/const DEPTH_LEGEND\s*=/);
  assert(legend !== null, "the depth column's definition is written once, as a constant");
  assert(
    /title=\{DEPTH_LEGEND\}/.test(tiers),
    "the depth column points at its definition with a title",
  );
  assert(
    /sr-only[^>]*>\{`\s*\(\$\{DEPTH_LEGEND\}\)`\}/.test(tiers),
    "and announces the SAME constant to a screen reader, so it is not hover only",
  );
}

finish();
