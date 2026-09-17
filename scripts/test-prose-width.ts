// The reading width is ONE number, in one place (#1888, guarded by #1895).
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
// Three things this holds, because the number moving is not the risk. The risk is
// the number moving in ONE of the places that carry it:
//
//   the second spelling   Tailwind's own `max-w-prose` is the identical cap
//                         reached by a different name, so raising the constant
//                         alone would have left half the app unchanged and the
//                         two would have disagreed silently from then on.
//   the written out one   `max-w-[70ch]` on the admin error boundary, which was
//                         a third spelling nothing reported: this guard's first
//                         run is what found it (#1895).
//   the skeletons         the loading boundary draws placeholder bars hand sized
//                         to mimic the real text. If the prose width moves and
//                         they do not, the page visibly jumps when the real
//                         content arrives.
//
// And the design record, which stated 65ch in three places for a fortnight after
// the number became 110. A record that disagrees with the code is worse than no
// record, because it is believed.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-prose-width.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "./lib/source-files.ts";
import { codeOnly, PROSE_HOME, scanProseWidth } from "./lib/scan-prose-width.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const STYLES = readFileSync(PROSE_HOME, "utf8");

const proseDecl = STYLES.match(/export const proseCls\s*=\s*"([^"]*)"/);
assert(proseDecl !== null, "proseCls is declared as a literal class string");
const proseCh = Number(proseDecl?.[1].match(/max-w-\[(\d+)ch\]/)?.[1] ?? NaN);
assert(Number.isFinite(proseCh), `proseCls declares a ch reading width (saw ${proseDecl?.[1]})`);
assert(
  proseCh >= 90 && proseCh <= 140,
  `the reading width fills the majority of a card without reaching its edge (saw ${proseCh}ch)`,
);

// --- no second spelling anywhere in the tree --------------------------------
//
// Through the shared enumeration (#2421), which refuses a listing it cannot
// believe rather than reporting a clean tree over zero files. The exemptions are
// by REASON on the line, never by a hardcoded path: a registry of allowed files
// would itself be exempt from the check it exists to enforce.
{
  const offenders = sourceFiles({
    match: /\.tsx?$/,
    exclude: (f) => /\.test\.tsx?$/.test(f),
  }).flatMap((f) => scanProseWidth(f, readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    assert(true, "no paragraph in src reaches the reading width by a second name");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.spelling}: ${o.why}`);
  }
}

// --- the design record carries the number the code carries -------------------
//
// DESIGN.md said 65ch in three separate sentences while `proseCls` was 110, so
// anybody reading the record to find the rule got the superseded answer and
// anybody writing to it reintroduced the drift this guard exists to prevent.
{
  const design = readFileSync("DESIGN.md", "utf8");
  const quoted = [...design.matchAll(/(\d+)\s*ch\b/g)].map((m) => Number(m[1]));
  assert(quoted.length >= 2, `the record states the reading width (saw ${quoted.length} mentions)`);
  const wrong = quoted.filter((n) => n !== proseCh);
  assert(
    wrong.length === 0,
    `every reading width in DESIGN.md is the one the code uses, ${proseCh}ch (saw ${wrong.join(", ")})`,
  );
  assert(
    design.includes("scripts/test-prose-width.ts"),
    "and the record names the guard holding the rule up, so an enforced rule is not read as an aspiration",
  );
}

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

// --- positive controls -------------------------------------------------------
//
// Both spellings render correctly and produce a plausible paragraph, so the
// defect is invisible on screen and a green run above has to be worth something.
{
  const caught = (code: string, what: string) => {
    const hits = scanProseWidth("src/x.tsx", code);
    assert(hits.length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanProseWidth("src/x.tsx", code);
    assert(
      hits.length === 0,
      `allowed: ${what}${hits.length ? ` (wrongly flagged ${hits[0].spelling})` : ""}`,
    );
  };

  // The six sites #1888 folded in, and the shape that would bring them back.
  caught('<p className="mt-2 max-w-prose text-sm">{body}</p>', "Tailwind's own name");
  caught('<p className="max-w-[65ch]">{body}</p>', "the old number written out");
  caught('<p className="max-w-[110ch]">{body}</p>', "the CURRENT number written out, which is still a second copy");
  caught('<p className="max-w-[72.5ch]">{body}</p>', "a fractional width");
  caught('<p className={`mt-2 max-w-prose ${x}`} />', "inside a template literal");

  allowed('<p className={`mt-2 ${proseCls}`}>{body}</p>', "the constant");
  allowed('<div className="max-w-2xl" />', "a container width, which is a different constant");
  allowed('<div className="max-w-[40rem]" />', "a width in another unit");
  allowed('<div className="w-[60ch]" />', "a fixed width rather than a cap");

  // The two real exceptions, both of which exist in the tree.
  allowed(
    '// prose-width-ok: this is a text INPUT, not a line of prose\n<textarea className="max-w-prose" />',
    "an opt-out in the comment block above",
  );
  allowed(
    '<textarea className="max-w-prose" /> // prose-width-ok: sizing a control',
    "an opt-out on the line",
  );
  allowed(
    '{/* prose-width-ok: a skeleton bar */}\n<div className="max-w-[88ch]" />',
    "an opt-out written as a JSX comment, which is the only comment JSX allows there",
  );
  caught('// prose-width-ok:\n<p className="max-w-prose" />', "an opt-out carrying no reason");
  caught(
    '// prose-width-ok: the reason\n<p className="max-w-prose" />\n<p className="max-w-[65ch]" />',
    "a second paragraph under one marker, which the marker does not reach",
  );

  // The home states the number and must never report itself. The same line in
  // any other file is a second copy of the constant, not a second home.
  caught('export const proseCls = "max-w-[110ch]";', "the constant redeclared somewhere else");
  eq(
    scanProseWidth(PROSE_HOME, 'export const proseCls = "max-w-[110ch]"; // and max-w-prose').length,
    0,
    "the home file is where the number lives",
  );

  // Documentation is not a call site. The natural response to flagging the
  // sentence that explains the rule is to delete the explanation.
  allowed(
    '/** `max-w-prose` is the identical 65ch by another name. */\nexport const x = 1;',
    "both spellings named inside a docstring",
  );
  {
    const before = "const a = 1;\n/* two\n   lines */\nconst b = 2;\n";
    eq(
      codeOnly(before).split("\n").length,
      before.split("\n").length,
      "stripping a comment does not move the line under it",
    );
  }
}

// --- a control drawn from the real tree --------------------------------------
//
// The synthetic fixtures prove the patterns match. This proves the guard still
// catches the defect in the file it really shipped in, read from disk and put
// back in memory, so nothing is written to the repo.
{
  const real = readFileSync("src/app/admin/error.tsx", "utf8");
  eq(scanProseWidth("src/app/admin/error.tsx", real).length, 0, "the fixed boundary is clean");

  const reverted = real.replace(
    /className=\{`mt-2 text-sm text-fg-muted \$\{proseCls\}`\}/,
    'className="mt-2 max-w-[70ch] text-sm text-fg-muted"',
  );
  assert(reverted !== real, "the overlay really put the third spelling back");
  eq(
    scanProseWidth("src/app/admin/error.tsx", reverted).length,
    1,
    "and the guard names it",
  );
}

finish();
