// One focus ring recipe, and nothing may declare its own colour (#1768).
//
// This is the guard that keeps the consolidation from eroding. Twenty five sites
// had set `focus-visible:outline-pennie-sky`, which measures 1.57:1 on beige, and
// they came back one component at a time because each one looked like a local
// styling decision. The colour is not a local decision: `globals.css` picks it by
// the SURFACE the ring lands on, since no single token clears 3:1 on both a beige
// page and a sky button (the numbers live in scripts/test-contrast.ts).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-focus-ring-recipe.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { scanFocusRings } from "./lib/scan-focus-rings.ts";
import { assert, fail, finish } from "./lib/harness.ts";

// --- the tree itself ---
//
// Through the shared enumeration (#2421), which refuses a listing it cannot
// believe rather than reporting a clean tree over zero files, and which reaches
// the file somebody is writing as well as the ones git already tracks.
//
// globals.css is where the recipe LIVES, so it is the one file that names the
// colour. Test files assert the absence of the old utility, which means they
// have to spell it.
{
  const offenders = sourceFiles({
    match: /\.(tsx?|css)$/,
    exclude: (f) => f === "src/app/globals.css" || /\.test\.tsx?$/.test(f),
  }).flatMap((f) => scanFocusRings(f, readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    assert(true, "no component in src/ declares its own focus ring colour");
  } else {
    for (const o of offenders) {
      fail(`${o.file}:${o.line} sets ${o.utility}: ${o.why}`);
    }
  }
}

// --- positive controls, so a scanner that stopped working cannot read as a clean tree ---
//
// The failure this guard exists to prevent is invisible (a ring nobody can see), so
// a green run has to be worth something. Each shape below is one the real tree
// carried, or one somebody would plausibly write next.
{
  const caught = (code: string, what: string) => {
    const hits = scanFocusRings("fixture.tsx", code);
    assert(hits.length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanFocusRings("fixture.tsx", code);
    assert(
      hits.length === 0,
      `allowed: ${what}${hits.length ? ` (wrongly flagged ${hits[0].utility})` : ""}`,
    );
  };

  // The exact shape that shipped 25 times.
  caught(
    'const cls = "rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky";',
    "the outline-pennie-sky utility that shipped 25 times",
  );
  // The same mistake in a different colour, which is the next one somebody writes.
  caught('<button className="focus-visible:outline-red-500" />', "another named colour");
  caught('<a className="focus-visible:outline-[#82d0ff]" />', "an arbitrary hex value");
  caught('<a className="focus-visible:outline-[var(--accent)]" />', "an arbitrary var() value");
  caught('<a className="focus:outline-pennie-sky" />', "the plain focus variant");
  caught('<a className="focus-within:outline-pennie-blue" />', "the focus-within variant");
  caught('<a className="dark:focus-visible:outline-pennie-sky" />', "a stacked dark variant");
  caught('<a className="focus-visible:ring-2 focus-visible:ring-pennie-sky" />', "a ring-* second recipe");

  // Shape, not contrast: a small control may legitimately tighten these, and the
  // global recipe reads the offset from a token so it can.
  allowed('<a className="focus-visible:outline-2 focus-visible:outline-offset-2" />', "width and offset");
  allowed('<a className="focus-visible:outline-offset-[-2px]" />', "a negative offset");
  allowed('<a className="focus-visible:outline-none" />', "suppressing the ring outright");
  allowed('<a className="focus-visible:outline-dashed" />', "an outline style");
  // Not a focus ring at all.
  allowed('<a className="outline-pennie-sky" />', "an outline outside any focus variant");
  allowed('<a className="hover:bg-pennie-sky" />', "a hover background");

  // The opt-out, on the line and in the block above it.
  allowed(
    '<a className="focus-visible:outline-pennie-sky" /> // focus-ring-ok: a deliberate exception with a reason',
    "an opt-out on the line",
  );
  allowed(
    '// focus-ring-ok: the reason\n<a className="focus-visible:outline-pennie-sky" />',
    "an opt-out in the comment block above",
  );
  // And an opt-out with NO reason is not an opt-out, or the convention decays into
  // a magic word.
  caught(
    '// focus-ring-ok:\n<a className="focus-visible:outline-pennie-sky" />',
    "an opt-out carrying no reason",
  );
}

// --- the recipe is in ONE place, and it is unlayered ---
{
  const css = readFileSync("src/app/globals.css", "utf8");

  assert(
    /--focus-ring-line:\s*var\(--pennie-blue\)/.test(css),
    "the light ring line is brand blue, the only measured colour that clears 3:1 on every ordinary light surface",
  );
  assert(
    /--focus-ring-line-on-accent:\s*var\(--pennie-graphite\)/.test(css),
    "a ring landing on a sky fill flips to graphite, which clears against the fill rather than against the page",
  );
  assert(
    /\[data-theme="dark"\][\s\S]*?--focus-ring-line:\s*var\(--accent\)/.test(css),
    "dark keeps the sky line, which passes on navy",
  );

  // The declaration list must be shared rather than written out per selector: the
  // three copies had to agree, and .pn-seg's was already a third spelling.
  const recipe = css.match(
    /:focus-visible,\s*\.pn-btn:focus-visible,\s*\.pn-seg:has\(\.pn-seg-input:focus-visible\),\s*\.dt-field:focus-within\s*\{([\s\S]*?)\}/,
  );
  assert(recipe !== null, "one declaration list serves every selector that draws a ring");
  if (recipe) {
    assert(
      /outline:\s*2px solid var\(--focus-ring-line\)/.test(recipe[1]),
      "the shared recipe draws the line from the token",
    );
    assert(
      /outline-offset:\s*var\(--focus-ring-offset\)/.test(recipe[1]),
      "the offset comes from a token, so a control can tighten it without restating the recipe",
    );
  }

  // Unlayered (#39). Inside @layer, a utility beats it and the ring silently
  // becomes whatever a class said, which is the state this issue is undoing.
  const layerEnd = css.indexOf("} /* end @layer components */");
  const recipeAt = css.indexOf(":focus-visible,\n.pn-btn:focus-visible");
  assert(layerEnd > 0, "the components layer's end is marked, so position can be judged");
  assert(
    recipeAt > layerEnd,
    "the focus recipe sits OUTSIDE @layer, so a layered utility cannot beat it (#39)",
  );
}

finish();
