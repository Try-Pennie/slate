// The test mode marker's treatment appears in exactly ONE place (#2660).
//
// A banner announcing a special mode has to look like nothing else in the
// product, or it reads as chrome (L623). That is the whole reason the marker is
// mint, which the design system keeps for illustration and uses functionally
// nowhere else. The moment a second surface borrows the mint, or the marker's
// classes, the signal is decoration. DESIGN.md's Test Mode Rule says so in
// words, and a rule stated only in prose is enforced by nothing (L27), so this
// is the enforcement, in the shape of the impersonation marker's own guard.
//
// Run: node --experimental-strip-types scripts/test-test-mode-marker-unique.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk("src");
assert(files.length > 100, `the scanner found source to judge (${files.length})`);

const CSS = join("src", "app", "globals.css");
const COMPONENT = join("src", "components", "TestModeBand.tsx");
const css = readFileSync(CSS, "utf8");

// --- the paint: mint is functional in the marker's rules and nowhere else -----
{
  // Every reference to the mint token outside the palette's own declaration
  // lines. The palette declares `--pennie-mint` once and aliases it once for
  // Tailwind; everything else is a USE.
  const uses = (src: string) =>
    src
      .split("\n")
      .filter((line) => /pennie-mint/.test(line))
      .filter((line) => !/^\s*--pennie-mint\s*:/.test(line) && !/^\s*--color-pennie-mint\s*:/.test(line));

  const cssUses = uses(css);
  eq(cssUses.length, 1, `globals.css paints mint in exactly one rule, the marker's token (${cssUses.join(" | ")})`);
  assert(/--test-mode-bg\s*:\s*var\(--pennie-mint\)/.test(cssUses[0] ?? ""), "and that rule is the test mode background");

  const strays = files.filter((f) => f !== CSS && uses(readFileSync(f, "utf8")).length > 0);
  eq(strays.join(", "), "", "no component paints mint on its own");
}

// --- the tokens: named in the stylesheet only ----------------------------------
{
  const strays = files.filter((f) => f !== CSS && /--test-mode-/.test(readFileSync(f, "utf8")));
  eq(strays.join(", "), "", "the test mode tokens are read only by the stylesheet's own rules");
  assert(/--test-mode-bg/.test(css) && /--test-mode-fg/.test(css), "and the stylesheet declares both");
}

// --- the classes: drawn by the marker component and nowhere else ---------------
for (const cls of ["pn-test-mode", "pn-test-mode-glyph", "pn-test-mode-say", "pn-test-mode-mark"]) {
  const users = files.filter((f) => f !== CSS && readFileSync(f, "utf8").includes(cls));
  // A test may name the class to assert the marker is there; that is a reader,
  // not a second painter.
  const strays = users.filter((u) => u !== COMPONENT && !/\.test\.tsx?$/.test(u));
  eq(strays.join(", "), "", `${cls} is drawn by the marker component alone`);
  assert(users.includes(COMPONENT), `${cls} is actually drawn by the marker (not a dead class)`);
  assert(css.includes(`.${cls}`), `${cls} has a rule in the stylesheet`);
}

// --- the component is used, so the classes above are live -----------------------
{
  const importers = files.filter(
    (f) => f !== COMPONENT && !/\.test\.tsx?$/.test(f) && /from "@\/components\/TestModeBand"/.test(readFileSync(f, "utf8")),
  );
  assert(importers.length >= 4, `the marker is drawn by the surfaces that show a test booking (${importers.length} importers)`);
}

finish();
