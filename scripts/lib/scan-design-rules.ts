// Scan logic for the three mechanically checkable rules in DESIGN.md (#1813),
// beside its test so it is unit testable with positive controls.
//
// DESIGN.md records Slate's visual system as named rules and, until this, two of
// them were held up by anything: the colour pairings (`test-contrast.ts`) and the
// focus ring recipe (`test-focus-ring-recipe.ts`). Every other rule rested on
// whoever happened to read the file, and on the day the record was merged a tier
// coverage glyph shipped breaking two of its principles at once.
//
// WHY THESE THREE and not the others. Each of them fails INVISIBLY, which is what
// makes a rule erode rather than get noticed:
//
//   a weight above 600  `font-synthesis: none` is set and 700 is aliased to
//     SemiBold in the font config, so `font-bold` renders as 600 anyway. The
//     mistake is correct on screen and wrong in the code, which is the only kind
//     nobody ever finds by looking.
//   a pill shaped button  reads as a status tag, so it steals the affordance from
//     the real controls on the screen. It looks deliberate.
//   a yellow, mint or peach call to action  is legible, pleasant, and quietly
//     breaks the One Pen Rule, whose whole value is sky's rarity.
//
// WHAT IS DELIBERATELY NOT HERE, said out loud rather than skipped in silence:
//
//   TABULAR NUMERALS on comparable figures. It stays ADVISORY. Deciding whether
//     a figure is comparable down a column needs to know what the column is, and
//     a scan for a number beside `tabular-nums` would name every count, id and
//     duration in the product on its first run. A rule that fires on dozens of
//     legitimate sites is one nobody reads by the second week (L36).
//
//   A COMPONENT SUPPLYING ITS OWN SPACING (#1792). Already owned, for the one
//     case that caused it, by `scripts/test-spinner-recipe.ts`. Generalising it
//     means deciding whether a mark is adjacent to text, which is a layout
//     question no static scan can answer.
//
// WHAT THESE THREE ARE BLIND TO, so a green run is never read as broader coverage:
// a class assembled from fragments (`bg-${tone}-500`), a weight set from a CSS
// file outside `globals.css`, and any of the three reached through a shared
// component's own class string, which is judged where that string is written
// rather than at each call site.

import { hasOptOut } from "./opt-out.ts";

export type DesignRuleHit = {
  file: string;
  line: number;
  rule: "600-ceiling" | "pill-button" | "one-pen";
  found: string;
  why: string;
};

/** Anything a person presses or follows. */
const CONTROL_TAGS = new Set(["button", "a", "Link", "SubmitButton", "NavLink"]);

/**
 * A weight OFF the typeface's ladder, in every spelling that reaches the DOM.
 *
 * PP Mori ships exactly 200, 400 and 600, so the rule is not only about going
 * heavier. `font-medium` is 500 and `font-light` is 300, neither of which
 * exists: the browser picks a neighbour and the result is a weight nobody chose,
 * rendering as a face the design never named. 600 is the ceiling and the
 * signature weight, so `font-semibold` is not here.
 */
const OFF_LADDER = "(?:100|300|500|[7-9]00|1000)";
const HEAVY_WEIGHT_RE = new RegExp(
  `\\bfont-(?:thin|light|bold|extrabold|black|medium)\\b` +
    `|\\bfont-\\[${OFF_LADDER}\\]` +
    `|font-weight\\s*:\\s*(?:${OFF_LADDER}|bold|bolder|lighter)\\b` +
    `|fontWeight\\s*:\\s*["']?(?:${OFF_LADDER}|bold|bolder|lighter)`,
  "g",
);

/** A fully rounded corner, in a class or in CSS. */
const FULLY_ROUNDED_RE = /\brounded-full\b|border-radius\s*:\s*9{3,4}px/;

/**
 * What makes a fully rounded control a PILL rather than a circle.
 *
 * A circular icon button and a calendar day cell are both `rounded-full` and
 * neither reads as a status tag; the shape that does is the one with room for a
 * word in it. Horizontal padding, or a control told to fill its row, is that
 * shape. Checking the radius alone would name the avatar, the status dot, the
 * skeleton and every day of the month picker on the first run.
 */
const PILL_SHAPE_RE = /\bpx-[\d.]|\bpx-\[|\bp-[2-9]\b|\bw-full\b|\bpx-\d/;

/** A fill from the illustration accents, which may never mean "do this". */
const ACCENT_FILL_RE =
  /\b(?:hover:|dark:|focus:)*bg-(?:pennie-)?(?:yellow|mint|peach)(?:-\w+)?\b|bg-\[var\(--(?:pennie-)?(?:yellow|mint|peach)[^)]*\)\]/;

function optedOut(lines: string[], i: number): boolean {
  return hasOptOut(lines, i, "design-ok:");
}

/**
 * The JSX tag an offset sits inside: the nearest element opened before it.
 *
 * A JSX element's attributes routinely run over a dozen lines, and an `onClick`
 * arrow carries a `>` of its own, so the opening tag cannot be matched as a
 * whole. Reading backwards to the nearest `<Identifier` answers the only
 * question these rules ask, which is what kind of thing the class is on.
 */
export function enclosingTag(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const opens = [...before.matchAll(/<([A-Za-z][\w.]*)/g)];
  const last = opens[opens.length - 1];
  return last ? last[1] : null;
}

function isControl(tag: string | null): boolean {
  return tag !== null && CONTROL_TAGS.has(tag);
}

/** Every break of the three rules in one file. */
export function scanDesignRules(file: string, source: string): DesignRuleHit[] {
  const hits: DesignRuleHit[] = [];
  const lines = source.split("\n");
  // Offsets of each line's start, so a tag can be resolved from a line number.
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }

  lines.forEach((line, i) => {
    // A comment is not code. A file explaining a rule has to name what it forbids.
    if (/^\s*(?:\/\/|\*|\{?\/\*)/.test(line)) return;
    if (optedOut(lines, i)) return;

    for (const m of line.matchAll(HEAVY_WEIGHT_RE)) {
      hits.push({
        file,
        line: i + 1,
        rule: "600-ceiling",
        found: m[0],
        why:
          "PP Mori ships 200, 400 and 600. font-synthesis is none and 700 is aliased, so a weight " +
          "off that ladder renders as one the design never named and the mistake is invisible on " +
          "screen. Emphasis comes from size, colour or space (The 600 Ceiling Rule)",
      });
    }

    // The tag is resolved at the MATCH, never at the start of the line: a whole
    // element routinely fits on one line, and reading from the line's own start
    // finds whatever was open before it, which for a single line element is
    // nothing at all.
    const round = line.match(FULLY_ROUNDED_RE);
    if (round && PILL_SHAPE_RE.test(line)) {
      const tag = enclosingTag(source, starts[i] + (round.index ?? 0));
      if (isControl(tag)) {
        hits.push({
          file,
          line: i + 1,
          rule: "pill-button",
          found: round[0],
          why:
            `a fully rounded <${tag}> with room for a word in it reads as a status tag and steals ` +
            "the affordance from the real controls on the screen. Buttons are 12px or 16px " +
            "(The Pills Are Badges Rule)",
        });
      }
    }

    const accent = line.match(ACCENT_FILL_RE);
    if (accent) {
      const tag = enclosingTag(source, starts[i] + (accent.index ?? 0));
      if (isControl(tag)) {
        hits.push({
          file,
          line: i + 1,
          rule: "one-pen",
          found: accent[0],
          why:
            `a <${tag}> filled with an illustration accent. Sky is the only colour that may mean ` +
            `"do this", and its rarity is what makes it work (The One Pen Rule)`,
        });
      }
    }
  });

  return hits;
}
