// Tripwire for the #39 cascade contract: the ported .pn-* recipes live in
// @layer components (so Tailwind utilities can override them at call sites),
// while the accessibility-critical rules MUST stay unlayered - unlayered CSS
// beats every layer, and the focus ring / sr-only / reduced-motion guard must
// keep winning over utilities.
// Run: node --experimental-strip-types scripts/test-css-layering.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const css = readFileSync(
  join(import.meta.dirname, "../src/app/globals.css"),
  "utf8",
);

// Strip comments so commentary can't confuse the scan.
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

// Walk the file tracking whether we're inside the @layer components block.
function selectorsInsideLayer(): { inside: string[]; outside: string[] } {
  const inside: string[] = [];
  const outside: string[] = [];
  let depth = 0;
  let layerDepth = -1;
  let buf = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") {
      const sel = buf.trim();
      if (/^@layer\s+components$/.test(sel)) layerDepth = depth;
      else if (sel && !sel.startsWith("@media") && layerDepth >= 0 && depth > layerDepth)
        inside.push(sel);
      else if (sel) outside.push(sel);
      depth++;
      buf = "";
    } else if (ch === "}") {
      depth--;
      if (layerDepth >= 0 && depth === layerDepth) layerDepth = -1;
      buf = "";
    } else buf += ch;
  }
  return { inside, outside };
}

assert(/@layer\s+components\s*\{/.test(code), "@layer components block exists");

const { inside, outside } = selectorsInsideLayer();

// .pn-* recipes are layered (overridable by utilities).
for (const sel of [".pn-h1", ".pn-lead", ".pn-btn", ".pn-card"]) {
  assert(
    inside.some((s) => s.split(",").some((p) => p.trim().startsWith(sel))),
    `${sel} is inside @layer components`,
  );
}

// The a11y-critical rules are NOT layered (they must beat utilities).
assert(
  outside.some((s) => s.trim() === ":focus-visible"),
  "global :focus-visible recipe stays unlayered",
);
assert(
  outside.some((s) => s.includes(".pn-btn:focus-visible")),
  ".pn-btn:focus-visible stays unlayered",
);
assert(
  !inside.some((s) => s.includes(":focus-visible")),
  "no focus-visible rule snuck inside the layer",
);
assert(
  outside.some((s) => s.trim() === ".sr-only"),
  ".sr-only stays unlayered",
);
assert(
  !inside.some((s) => s.trim() === ".sr-only"),
  ".sr-only is not duplicated inside the layer",
);
assert(
  /@media\s*\(prefers-reduced-motion: reduce\)/.test(code) &&
    !inside.some((s) => s.includes("prefers-reduced-motion")),
  "reduced-motion guard exists and is not inside the layer",
);

finish();
