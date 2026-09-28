// Finds every class string in source that paints the rose (`--error`) as one half
// of a text pairing, so the contrast guard can measure each pair it finds rather
// than the one pair somebody remembered to list (#2611).
//
// The defect this exists for: `--error` flips with the theme (the dark block
// lightens it), so any foreground laid on a rose FILL, and any fill a rose LABEL
// is laid on, is one half of a pair whose other half must flip with it (L213).
// `bg-[var(--error)] text-white` reads 5.14:1 in light and 2.39:1 in dark, and it
// had been written by hand at six sites, one of them the lead's cancel button.
//
// Pure: it takes source text and returns the pairs, so a fixture can prove it
// still finds the shape it was written for (L1). Resolving a class to a token and
// measuring it belongs to scripts/test-contrast.ts, which owns the token parser.

export type ClassPair = {
  /** The background colour class, unprefixed (`bg-[var(--error)]`). */
  bg: string;
  /** The text colour class, unprefixed (`text-white`). */
  fg: string;
  /** The whole literal, so a failure can be found by searching for it. */
  literal: string;
  /** 1 based line of the literal's opening quote. */
  line: number;
  /**
   * What the same control paints in each INTERACTIVE state the literal declares
   * (#2836). The rest pair is not the only pair a person reads: a pointer resting
   * on the button is in the hover state at the moment of pressing, and a keyboard
   * user is in the focus state. A state that restates neither colour inherits the
   * rest one, so every entry is a complete pair ready to measure.
   */
  states: StatePaint[];
};

/** One interactive state of a rose pairing, resolved to a complete paint. */
export type StatePaint = {
  /** The variant prefix (`hover`, `focus`, `focus-visible`, `active`). */
  state: string;
  /** The background colour class in that state, unprefixed. */
  bg: string;
  /** The text colour class in that state, unprefixed. */
  fg: string;
  /**
   * The element's opacity in that state, 1 when none is declared. Anything below
   * 1 fades the fill AND the label over whatever is behind the control, so the
   * pair can only be measured once it is composited over a real background.
   */
  opacity: number;
};

/**
 * The interactive states measured. `disabled:` is deliberately absent: WCAG 1.4.3
 * exempts an inactive control, and `disabled:opacity-60` is how every button here
 * says it cannot be pressed.
 */
const INTERACTIVE_STATES = ["hover", "focus", "focus-visible", "active"];

/**
 * Every interactive state a literal declares a colour or an opacity for, with the
 * rest classes filled in wherever the state does not restate them.
 */
export function interactiveStates(
  literal: string,
  restBg: string,
  restFg: string,
  isColour: (token: string) => boolean,
): StatePaint[] {
  const out: StatePaint[] = [];
  const classes = literal.split(/\s+/).filter(Boolean);
  for (const state of INTERACTIVE_STATES) {
    const own = classes
      .filter((c) => c.startsWith(`${state}:`))
      .map((c) => c.slice(state.length + 1))
      .filter((c) => !c.includes(":"));
    const colour = (c: string, prefix: "bg" | "text") => {
      if (!c.startsWith(`${prefix}-`)) return false;
      const t = tokenForColourClass(c);
      return t !== null && (/^\w+-\[var\(/.test(c) || isColour(t));
    };
    const bg = own.find((c) => colour(c, "bg"));
    const fg = own.find((c) => colour(c, "text"));
    const op = own.map((c) => c.match(/^opacity-(\d+)$/)).find((m) => m !== null);
    if (!bg && !fg && !op) continue;
    out.push({
      state,
      bg: bg ?? restBg,
      fg: fg ?? restFg,
      opacity: op ? Number(op[1]) / 100 : 1,
    });
  }
  return out;
}

/** Class names that paint the rose, in either half. */
const ROSE = new Set(["error", "[var(--error)]"]);

/**
 * `bg-[var(--x)]` -> `--x`, `bg-white` -> `--pennie-white`, `bg-surface` ->
 * `--surface`. Returns null for a class carrying an alpha (`bg-error/25`), whose
 * painted colour depends on what is behind it and so is not a token at all.
 */
export function tokenForColourClass(cls: string): string | null {
  const bare = cls.replace(/^(bg|text)-/, "");
  if (bare.includes("/")) return null;
  const v = bare.match(/^\[var\((--[\w-]+)\)\]$/);
  if (v) return v[1];
  if (bare === "white") return "--pennie-white";
  if (/^[a-z][\w-]*$/.test(bare)) return `--${bare}`;
  return null;
}

/**
 * Every literal whose UNPREFIXED classes include a background and a text colour,
 * at least one of which is the rose. Hover and other variant classes are not
 * paired with the rest classes, since they describe a different state; each
 * interactive state is reported separately on `states` (#2836), resolved to the
 * complete pair it paints.
 *
 * A text class is only a colour if `isColour` says its token exists, which is how
 * `text-sm` and `text-center` are told from `text-fg` without a list of sizes.
 */
export function scanRosePairings(src: string, isColour: (token: string) => boolean): ClassPair[] {
  const out: ClassPair[] = [];
  const literalRe = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  for (const m of src.matchAll(literalRe)) {
    const literal = m[2];
    const classes = literal.split(/\s+/).filter((c) => c && !c.includes(":"));
    const colourOf = (prefix: "bg" | "text") =>
      classes.filter((c) => {
        if (!c.startsWith(`${prefix}-`)) return false;
        const t = tokenForColourClass(c);
        if (t === null) return false;
        // An explicit `[var(--x)]` is a colour by construction, so it is always
        // kept and a misspelt token THROWS when measured rather than being
        // skipped as though it were `text-sm` (L11). Only a NAMED class needs
        // the lookup, to tell `text-fg` from a size or an alignment.
        return /^\w+-\[var\(/.test(c) || isColour(t);
      });
    const bgs = colourOf("bg");
    const fgs = colourOf("text");
    if (bgs.length === 0 || fgs.length === 0) continue;
    const bare = (c: string) => c.replace(/^(bg|text)-/, "");
    if (!bgs.some((c) => ROSE.has(bare(c))) && !fgs.some((c) => ROSE.has(bare(c)))) continue;
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    for (const bg of bgs) {
      for (const fg of fgs) out.push({ bg, fg, literal, line, states: interactiveStates(literal, bg, fg, isColour) });
    }
  }
  return out;
}
