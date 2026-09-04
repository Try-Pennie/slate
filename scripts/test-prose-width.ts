// The reading width is ONE number, in one place (#1888).
//
// #1745 made two decisions at once: internal pages were unified onto two content
// widths (80rem wide, 48rem narrow), and every descriptive paragraph was
// separately capped at a reading width. The card follows the page width and the
// sentence inside it follows the reading cap, so on a wide page those two numbers
// are far apart, and the gap is what reads as text wrapping with half the card
// empty beside it.
//
// The cap itself is right in principle: without it a sentence runs the full
// 1280px on a wide monitor, which is what #1745 was opened to fix. The NUMBER was
// wrong, and it was chosen against a page rather than against the card the text
// actually sits in.
//
// Two things this holds, because the number moving is not the risk. The risk is
// the number moving in ONE of the places that carry it:
//
//   the second spelling   Tailwind's own `max-w-prose` is the identical cap
//                         reached by a different name, so raising the constant
//                         alone would have left half the app unchanged and the
//                         two would have disagreed silently from then on.
//   the skeletons         the loading boundary draws placeholder bars hand sized
//                         to mimic the real text. If the prose width moves and
//                         they do not, the page visibly jumps when the real
//                         content arrives.
// Run: node --experimental-strip-types scripts/test-prose-width.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const STYLES = readFileSync(join("src", "components", "ui", "styles.ts"), "utf8");

const proseDecl = STYLES.match(/export const proseCls\s*=\s*"([^"]*)"/);
assert(proseDecl !== null, "proseCls is declared as a literal class string");
const proseCh = Number(proseDecl?.[1].match(/max-w-\[(\d+)ch\]/)?.[1] ?? NaN);
assert(Number.isFinite(proseCh), `proseCls declares a ch reading width (saw ${proseDecl?.[1]})`);
assert(
  proseCh >= 90 && proseCh <= 140,
  `the reading width fills the majority of a card without reaching its edge (saw ${proseCh}ch)`,
);

// --- the second spelling is gone ---------------------------------------------
//
// One use is deliberately exempt and is not prose at all: a text INPUT sized by
// the same class, where the number is a control's width rather than a line
// length. It carries a reason, and the exemption is by REASON rather than by a
// hardcoded path, so a second control sized this way is covered too.
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Source with the prose stripped out of it.
 *
 * These files NAME the class while explaining themselves, so scanning the raw
 * text finds the explanation as well as the code and reports a paragraph that is
 * not there. Block comments go entirely; a line comment survives only if it
 * carries the opt-out marker, which has to stay readable for the lookback below
 * to find it (L361: judging a container by its start fails in both directions,
 * so the excluded text is removed from INSIDE it).
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) && !line.includes("prose-width-ok:") ? "" : line))
    .join("\n");
}

const offenders: string[] = [];
for (const file of sources("src")) {
  const text = code(readFileSync(file, "utf8"));
  text.split("\n").forEach((line, i) => {
    if (!line.includes("max-w-prose")) return;
    // `prose-width-ok:` on the line, or in the comment block just above it.
    const above = text.split("\n").slice(Math.max(0, i - 4), i).join("\n");
    if (/prose-width-ok:/.test(line) || /prose-width-ok:/.test(above)) return;
    offenders.push(`${file}:${i + 1}`);
  });
}
assert(
  offenders.length === 0,
  `no paragraph reaches the reading width by Tailwind's own name (saw ${offenders.join(", ")})`,
);

// --- the skeletons moved with it ---------------------------------------------
const loading = readFileSync(join("src", "app", "admin", "loading.tsx"), "utf8");
const bars = [...loading.matchAll(/max-w-\[(\d+)ch\]/g)].map((m) => Number(m[1]));
assert(bars.length >= 2, `the loading header draws placeholder text bars (saw ${bars.length})`);
for (const bar of bars) {
  assert(
    bar <= proseCh,
    `a placeholder bar (${bar}ch) must not be wider than the text it stands in for (${proseCh}ch)`,
  );
}
// A bar far shorter than the real line is the jump this exists to prevent, in
// the other direction: the skeleton reads as a stub and the text arrives wider.
assert(
  Math.max(...bars) >= proseCh * 0.6,
  `the longest placeholder bar (${Math.max(...bars)}ch) still looks like a line of text at ${proseCh}ch`,
);

finish();
