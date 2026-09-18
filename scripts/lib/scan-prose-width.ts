// Scan logic for the reading width guard (#1895), beside its test so it is unit
// testable with positive controls.
//
// The reading width is ONE number and it lives in `proseCls`. It had two
// spellings that meant the same thing: `max-w-[65ch]` in the constant and
// Tailwind's own `max-w-prose`, which resolves to the identical 65ch under a
// different name, at six call sites. Nothing reported the disagreement, because
// both rendered correctly and produced the same width, right up until #1888
// raised one of them. A shared constant half the call sites bypass is not a
// single source of truth, it is a constant plus a habit.
//
// So BOTH spellings are caught, and the second one matters more now than it did
// when the issue was written: `max-w-prose` is gone from the tree and the cap is
// 110ch, so a fresh `max-w-[65ch]` written from memory would be a third of the
// text width short and nothing would say so.
//
// WHAT IT IS BLIND TO, so a green run is never read as broader coverage:
//
//   A WIDTH IN ANY OTHER UNIT. `max-w-2xl`, `max-w-[40rem]` and `w-[60ch]` are
//     not matched. `ch` is the reading width's unit and `max-w` is how it is
//     expressed, and widening to every width utility would name the page and
//     card widths (#1745's decision, a different constant) on the first run.
//
//   A CLASS ASSEMBLED FROM FRAGMENTS. `max-w-[${n}ch]` is not matched, and
//     Tailwind cannot see it either, so a class built that way does not render.
//
// Comments are stripped before the scan: the files that OWN this rule name both
// spellings while explaining themselves, and a scan of the raw text reports the
// explanation as a paragraph that is not there.

import { hasOptOut, textHasOptOut } from "./opt-out.ts";

export type ProseWidthHit = {
  file: string;
  line: number;
  spelling: string;
  why: string;
};

/** The one file allowed to state the number. */
export const PROSE_HOME = "src/components/ui/styles.ts";

/** The opt-out, which must carry a reason on its own line (L675). */
// The marker must sit directly behind a comment opener, `*` included so a
// docstring continuation line can carry it. Requiring an opener is what stops
// the same words inside a string literal from opting anything out.

/** Tailwind's own name for the same 65ch. */
const NAMED_RE = /\bmax-w-prose\b/g;

/** A reading width written out: `max-w-[65ch]`, `max-w-[72.5ch]`. */
const LITERAL_RE = /\bmax-w-\[[0-9.]+ch\]/g;

/** Source with comments blanked, line count preserved, opt-out lines kept. */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) =>
      // A preserved block keeps its lines, each marked as a comment. Its
      // CONTINUATION lines start with an ordinary word, so without this the
      // lookback below meets one, reads it as code, and stops short of the
      // marker sitting two lines further up. That is how a JSX comment, which is
      // the only comment JSX allows between elements, failed to opt anything out.
      textHasOptOut(m, "prose-width-ok:")
        ? m
            .split("\n")
            .map((l) => `//${l}`)
            .join("\n")
        : m.replace(/[^\n]/g, " "),
    )
    .split("\n")
    .map((line) => {
      if (!/^\s*(?:\/\/|\*)/.test(line)) return line;
      return textHasOptOut(line, "prose-width-ok:") ? line : "";
    })
    .join("\n");
}

function optedOut(lines: string[], i: number): boolean {
  // Bounded reach: the subject line here is a rendered class rather than a
  // statement, so a marker six lines up is as close as the convention gets.
  return hasOptOut(lines, i, "prose-width-ok:", { reach: 6 });
}

/** Every hand written reading width in one file. */
export function scanProseWidth(file: string, source: string): ProseWidthHit[] {
  if (file === PROSE_HOME) return [];
  const hits: ProseWidthHit[] = [];
  const lines = codeOnly(source).split("\n");

  lines.forEach((line, i) => {
    if (optedOut(lines, i)) return;
    for (const m of line.matchAll(NAMED_RE)) {
      hits.push({
        file,
        line: i + 1,
        spelling: m[0],
        why: `Tailwind's own name for a reading width, which is a second spelling of \`proseCls\`; import it from ${PROSE_HOME}`,
      });
    }
    for (const m of line.matchAll(LITERAL_RE)) {
      hits.push({
        file,
        line: i + 1,
        spelling: m[0],
        why: `a reading width written out; import \`proseCls\` from ${PROSE_HOME} or say why this one is not prose`,
      });
    }
  });

  return hits;
}
