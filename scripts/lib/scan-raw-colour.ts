// Scan logic for the raw colour guard (#1903), beside its test so it is unit
// testable with positive controls.
//
// The rule CLAUDE.md states and nothing enforced: a colour in `src/` comes from
// a token, never from a literal. The literal is the thing that drifts, because
// each one looks like a local styling decision at the point it is written, and
// because a literal cannot follow the theme: `rgba(196,61,61,0.12)` is the light
// rose at 12% in both themes, while `var(--error)` is a lighter rose on a dark
// card on purpose.
//
// EVERY SPELLING, not just hex. A hex only scan is the version that flags
// `text-[#C43D3D]` and passes the `bg-[rgba(196,61,61,0.12)]` beside it, which
// leaves a fill and its own foreground declared two different ways: half a fix
// that reads as a whole one (L213, L273). So the colour FUNCTIONS are matched
// too.
//
// WHAT IT IS BLIND TO, stated here so a green run is never read as broader
// coverage than it has:
//
//   A SHORT PURE DECIMAL HEX. `#333` and `#2455` are valid CSS colours and are
//     spelled exactly like this repo's issue references, which appear in their
//     hundreds inside ordinary sentences (`refusal-catalog.ts` alone carries 20
//     in string literals, where stripping comments cannot reach them). A scan
//     that flagged them would name dozens of legitimate sentences on its first
//     run and be switched off in a week (L36). So a bare short hex counts only
//     when it carries a letter a to f; inside a Tailwind arbitrary value
//     (`bg-[#333]`) or after a CSS colour property it counts whatever its
//     digits, because an issue reference never appears in either place.
//
//   THE TAILWIND NAMED PALETTE. `bg-red-500` and `text-white` are raw colours by
//     the same argument, and they are deliberately out of scope: a scan for the
//     bare utility matches ordinary English, `absent-from-slate` being six live
//     hits in `src/lib/twilio/roster.ts` and `schedule-parity-alert.ts`, and the
//     class names are routinely built from fragments no static scan can join.
//     `scripts/test-focus-ring-recipe.ts` already covers the case that shipped
//     25 times, which was a named palette colour on a focus ring.
//
//   A COLOUR ARRIVING AT RUNTIME. The embed's `brand` parameter is a host's own
//     hex and is supposed to be a literal; it never appears in this tree.
//
// Comments are stripped before the scan rather than judged line by line. Several
// files document which token they mean by naming its value, and the natural
// response to a guard flagging the documentation is to delete the sentence that
// explains the colour, which is worse than the thing it was reporting.

export type RawColourHit = {
  file: string;
  line: number;
  value: string;
  why: string;
};

/** Where a literal is the declaration rather than a use of one. */
export const TOKEN_HOME = "src/app/globals.css";

/** The opt-out, which must carry a reason on its own line (L675). */
// The marker must sit directly behind a comment opener, and `*` counts because a
// docstring's continuation lines start with one: a reason worth writing usually
// belongs in the docstring that already explains the value rather than in a
// second comment beside it. Requiring an opener is what stops the same words
// inside a string literal from opting anything out.
const OPT_OUT_RE = /(?:\/\/|\/\*|\*)[^\S\r\n]*colour-ok:[^\S\r\n]*\S+/;

/**
 * The whole file is a declaration site, and says why.
 *
 * One shape needs it: `src/app/global-error.tsx` renders its OWN document, so
 * `globals.css` never loads and a variable that cannot be loaded is not a
 * variable. Its eleven values are a second, framework forced copy of the
 * palette, and they are already held to the first copy by
 * `scripts/test-global-error-tokens.ts`, which is a stronger check than this one
 * could make. Eleven per line markers would say the same thing eleven times.
 *
 * It must sit in the file's opening 40 lines, beside the explanation, and
 * `scripts/test-raw-colour.ts` NAMES every file carrying one on every run, so a
 * standing exemption is listed rather than silent (L523).
 */
const FILE_OPT_OUT_RE = /(?:\/\/|\*|\/\*)[^\S\r\n]*colour-ok-file:[^\S\r\n]*\S+/;
const FILE_OPT_OUT_WINDOW = 40;

/** True when `source` declares itself a colour declaration site, with a reason. */
export function fileOptedOut(source: string): boolean {
  return FILE_OPT_OUT_RE.test(source.split("\n").slice(0, FILE_OPT_OUT_WINDOW).join("\n"));
}

/**
 * A colour written as a function call: rgb(), rgba(), hsl(), oklch() and kin.
 *
 * The arguments are captured as well as the name, because two of these
 * routinely sit on ONE line (a fill and the border beside it) and a hit reported
 * as the bare name would deduplicate them into one, which is how a partly fixed
 * pairing reads as a whole one.
 */
const COLOUR_FN_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\([^)\n]*\)?/g;

/** A six or eight digit hex, which no issue reference in this repo can be. */
const LONG_HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;

/** A three or four digit hex carrying a letter, so `#fff` counts and `#333` cannot. */
const SHORT_HEX_WITH_LETTER_RE = /#(?=[0-9a-fA-F]{3,4}\b)(?:[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*)\b/g;

/**
 * Any hex sitting where only a colour can sit: inside a Tailwind arbitrary value
 * or after a CSS colour property. This is what recovers `bg-[#333]`, which the
 * letter rule above cannot see.
 */
const HEX_IN_COLOUR_SLOT_RE =
  /(?:\[[^\]]*|(?:color|background|background-color|border-color|fill|stroke|outline-color|box-shadow|text-shadow)\s*:[^;\n]*)(#[0-9a-fA-F]{3,8})\b/g;

/**
 * Source with comments blanked out, line count preserved.
 *
 * A line comment survives only when it carries the opt-out, which has to stay
 * readable for the lookback to find it: the excluded text is removed from INSIDE
 * the file rather than the file being judged by how it starts (L361).
 */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) =>
      // A preserved block keeps its lines, each marked as a comment, so the
      // lookback below can walk up to the marker: a block comment's
      // CONTINUATION lines start with an ordinary word and would otherwise read
      // as code and stop it short.
      OPT_OUT_RE.test(m)
        ? m
            .split("\n")
            .map((l) => `//${l}`)
            .join("\n")
        : m.replace(/[^\n]/g, " "),
    )
    .split("\n")
    .map((line) => {
      if (!/^\s*(?:\/\/|\*)/.test(line)) return line;
      return OPT_OUT_RE.test(line) ? line : "";
    })
    .join("\n");
}

function optedOut(lines: string[], i: number): boolean {
  if (OPT_OUT_RE.test(lines[i])) return true;
  for (let back = i - 1; back >= 0 && back >= i - 4; back--) {
    const prev = lines[back];
    if (OPT_OUT_RE.test(prev)) return true;
    // Stop at the first line that is neither a comment nor blank, so a marker
    // belonging to an earlier statement cannot cover this one.
    if (prev.trim() !== "" && !/^\s*(?:\{?\/\*|\/\/|\*)/.test(prev)) return false;
  }
  return false;
}

/** Every raw colour in one file. `file` is used only to report the hit. */
export function scanRawColour(file: string, source: string): RawColourHit[] {
  if (fileOptedOut(source)) return [];
  const hits: RawColourHit[] = [];
  const lines = codeOnly(source).split("\n");

  lines.forEach((line, i) => {
    if (optedOut(lines, i)) return;
    const seen = new Set<string>();
    const add = (value: string, why: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      hits.push({ file, line: i + 1, value, why });
    };

    for (const m of line.matchAll(COLOUR_FN_RE)) {
      add(m[0], "a colour written as a function cannot follow the theme; take it from a token");
    }
    for (const m of line.matchAll(LONG_HEX_RE)) {
      // A numeric character reference (&#9662;) is not a colour.
      if (line[m.index - 1] === "&") continue;
      add(m[0], "a hex literal; take the colour from a token");
    }
    for (const m of line.matchAll(SHORT_HEX_WITH_LETTER_RE)) {
      if (line[m.index - 1] === "&") continue;
      add(m[0], "a short hex literal; take the colour from a token");
    }
    for (const m of line.matchAll(HEX_IN_COLOUR_SLOT_RE)) {
      add(m[1], "a hex literal in a colour slot; take the colour from a token");
    }
  });

  return hits;
}
