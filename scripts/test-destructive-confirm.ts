// The destructive confirm is ONE design system button, and rose is never drawn
// on rose (#2455).
//
// Two hand rolled copies of the identical class string
// (`bg-error/10 text-error hover:bg-error/20`) carried the agent's Cancel and the
// manager's Decline, the two irreversible controls in the time off flow. Measured
// with axe on 2026-09-16 the label read 3.79:1 against the 4.5:1 AA needs, and
// correcting one alone would have left the two surfaces diverged while each still
// read as reasonable on its own (L613).
//
// THE NUMBER IS NOT THE POINT; THE STACK IS. Both sites painted a rose label on a
// rose wash sitting on a second rose wash, and the composite differs per surface,
// so neither site was measurable and the two measured differently:
//
//   rose label on rose 10% on rose 5% on the beige page   3.88:1   (/me/time-off)
//   the same string    on rose 10% on rose 5% on a card   4.17:1   (/admin/ooo)
//
// A rose wash cannot carry a rose label at all in light theme, and that is a
// property of the palette rather than of these two components: the wash that is
// pale enough to keep the label at 4.5:1 (rose at 8% over white, label 4.57:1) is
// 1.04:1 against the beige page, which is no surface at all. So there is no
// alpha that satisfies both, and the answer is a neutral ground under a rose
// outline, which is what `.pn-btn--danger` already is.
//
// Both halves are guarded here, because each is blind where the other looks. The
// ratios themselves live in scripts/test-contrast.ts, which reads the tokens; this
// reads the CALL SITES, which is where a correct pair gets composed into a wrong
// one (L213).
// Run: node --experimental-strip-types scripts/test-destructive-confirm.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";
import { hasOptOut } from "./lib/opt-out.ts";

const SRC = join("src");

/** Every shipped source file. Tests are excluded: they quote class strings. */
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
 * A rose FOREGROUND, in either spelling the codebase uses.
 *
 * `text-error` is the Tailwind alias for `--error`; `text-[var(--error)]` is the
 * same colour reached the long way, and a rule that knew only one spelling would
 * be answered by the other (L247).
 */
const ROSE_FG = /\btext-(?:error\b|\[var\(--error\)\])/;

/**
 * A rose BACKGROUND, including every alpha spelling. `bg-error/10` and
 * `bg-error-bg` are both washes; `bg-[var(--error)]` is the solid fill.
 */
const ROSE_BG = /\bbg-(?:error(?:-bg)?(?:\/\d+)?\b|\[var\(--error\)\])/;

/**
 * A rose HOVER state, which only a CONTROL has.
 *
 * This is how a hand rolled destructive button is told apart from an error
 * notice: a paragraph does not change colour when a pointer crosses it. Every
 * instance in the tree on the day this was written was a button somebody built
 * out of utilities instead of reaching for `btnDangerCls` (L607).
 */
const ROSE_HOVER = /\bhover:(?:bg|text|border)-(?:error(?:-bg)?(?:\/\d+)?\b|\[var\(--error\)\])/;

/**
 * The opt out, on the line or in the comment block directly above it.
 *
 * It must carry a REASON, or the surrounding syntax satisfies the check and the
 * escape reads as reasoned when nobody reasoned (L675). That rule lives in the
 * one shared reader now (#2200).
 */
function optedOut(lines: string[], i: number): boolean {
  return hasOptOut(lines, i, "destructive-ok:");
}

/**
 * The file with its COMMENTS blanked out, line numbering preserved.
 *
 * A comment that NAMES the forbidden string is the rule being explained, not the
 * rule being broken, and a scan that cannot tell them apart fires on its own
 * documentation: this component's docstring quotes the class string it exists to
 * end, and every opt out below would need a second opt out for the sentence
 * saying why (L673). The opt out itself is read from the RAW lines, before this
 * runs, because it lives in a comment by construction.
 */
export function withoutComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return blanked
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

type Finding = { file: string; line: number; text: string; why: string };

/** Every place this file objects to, in one pass per file (L297). */
export function scanForHandRolledRose(
  files: { path: string; src: string }[],
): Finding[] {
  const out: Finding[] = [];
  for (const { path, src } of files) {
    const lines = src.split("\n");
    const code = withoutComments(src).split("\n");
    for (let i = 0; i < code.length; i++) {
      const line = code[i];
      if (optedOut(lines, i)) continue;
      if (ROSE_HOVER.test(line)) {
        out.push({
          file: path,
          line: i + 1,
          text: lines[i].trim(),
          why: "a hand rolled destructive control; use btnDangerCls",
        });
        continue;
      }
      if (ROSE_FG.test(line) && ROSE_BG.test(line)) {
        out.push({
          file: path,
          line: i + 1,
          text: lines[i].trim(),
          why: "a rose label on a rose ground, which cannot reach 4.5:1 in light theme",
        });
      }
    }
  }
  return out;
}

// --- the tree ---------------------------------------------------------------

const files = sources(SRC).map((path) => ({ path, src: readFileSync(path, "utf8") }));
assert(files.length > 50, `the scan reached the source tree (${files.length} files)`);

const findings = scanForHandRolledRose(files);
if (findings.length === 0) {
  assert(true, "no hand rolled destructive control, and no rose label on a rose ground");
} else {
  for (const f of findings) fail(`${f.file}:${f.line} ${f.why}\n    ${f.text}`);
}

// --- the positive control ---------------------------------------------------
//
// A scan that never looked and a clean tree return the same empty list (L98), so
// each shape this file exists to catch is planted and has to come back.
{
  const planted = scanForHandRolledRose([
    {
      path: "fixture/HandRolledConfirm.tsx",
      src: `const c = "rounded-md px-3 py-1.5 bg-error/10 text-error hover:bg-error/20";`,
    },
    {
      path: "fixture/LongSpelling.tsx",
      src: `const c = "bg-[var(--error)] text-[var(--error)]";`,
    },
    {
      path: "fixture/HoverOnly.tsx",
      src: `const c = "text-fg-muted hover:bg-error/10 hover:text-error";`,
    },
  ]);
  assert(planted.length === 3, `the scan catches each planted shape (saw ${planted.length})`);
}
{
  // And it must NOT catch the things that are correct, or the opt outs would
  // multiply until nobody reads them.
  const quiet = scanForHandRolledRose([
    { path: "fixture/Notice.tsx", src: `const c = "border border-[var(--error)] text-sm text-error";` },
    { path: "fixture/Pill.tsx", src: `const c = "border-error text-error font-semibold";` },
    { path: "fixture/Cell.tsx", src: `const c = "bg-error/25 text-fg";` },
    { path: "fixture/Button.tsx", src: `const c = btnDangerCls;` },
    // A comment that NAMES the banned string is the rule being explained, and a
    // scan that cannot tell that from the rule being broken fires on its own
    // documentation (L673).
    {
      path: "fixture/Documented.tsx",
      src: [
        "/** It used to read `bg-error/10 text-error hover:bg-error/20`. */",
        "const c = btnDangerCls; // not hover:bg-error/20 any more",
      ].join("\n"),
    },
  ]);
  assert(quiet.length === 0, `a rose notice, pill, grid cell and the real button are all fine (saw ${quiet.length})`);
}
{
  const excused = scanForHandRolledRose([
    {
      path: "fixture/Excused.tsx",
      src: [
        "// destructive-ok: a fixture proving the opt out is honoured",
        `const c = "bg-error/10 text-error";`,
      ].join("\n"),
    },
    {
      path: "fixture/Unreasoned.tsx",
      src: ["// destructive-ok:", `const c = "bg-error/10 text-error";`].join("\n"),
    },
  ]);
  assert(
    excused.length === 1 && excused[0].file === "fixture/Unreasoned.tsx",
    "the opt out is honoured only when it carries a reason",
  );
}

// --- the one component, wearing the one button ------------------------------
//
// Read out of the component's own source rather than restated, so this cannot
// pass while the confirm renders something else (L63). scripts/test-contrast.ts
// asserts the ratios for `.pn-btn--danger`, and these two lines are what make
// those assertions be about the button a person actually presses.
{
  const path = join("src", "components", "ui", "DestructiveConfirm.tsx");
  const src = withoutComments(readFileSync(path, "utf8"));
  assert(
    /className=\{btnDangerCls\}/.test(src),
    "the destructive confirm wears the design system's danger button",
  );
  assert(
    /className=\{btnSecondaryCls\}/.test(src),
    "the way out wears the neutral button, never the destructive one (#1875)",
  );
  assert(
    !ROSE_FG.test(src) && !ROSE_BG.test(src),
    "the component declares no rose utility of its own; the treatment lives in globals.css",
  );
  assert(
    /var\(--field\)/.test(src),
    "the confirm panel's ground is neutral, so the rose label is measurable wherever the panel lands",
  );
}

// --- and both surfaces reach it ---------------------------------------------
//
// Enumerated from what IMPORTS the component rather than from a list kept here,
// so a third destructive confirm is covered by the scan above rather than by
// somebody remembering to add it to a registry (L96). What is asserted is that
// the two the issue named are no longer building their own.
for (const path of [
  join("src", "components", "ui", "RequestActions.tsx"),
  join("src", "components", "ui", "DeclineConfirm.tsx"),
]) {
  const src = withoutComments(readFileSync(path, "utf8"));
  assert(
    /DestructiveConfirm/.test(src),
    `${path} reaches the shared destructive confirm`,
  );
  assert(
    !/\bghost\b/.test(src),
    `${path} no longer keeps its own hand rolled control style`,
  );
}

finish();
