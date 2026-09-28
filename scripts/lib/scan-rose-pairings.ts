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
};

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
 * at least one of which is the rose. Hover and other variant classes are skipped:
 * they describe a different state, and the at rest pair is the one always drawn.
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
        return t !== null && isColour(t);
      });
    const bgs = colourOf("bg");
    const fgs = colourOf("text");
    if (bgs.length === 0 || fgs.length === 0) continue;
    const bare = (c: string) => c.replace(/^(bg|text)-/, "");
    if (!bgs.some((c) => ROSE.has(bare(c))) && !fgs.some((c) => ROSE.has(bare(c)))) continue;
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    for (const bg of bgs) for (const fg of fgs) out.push({ bg, fg, literal, line });
  }
  return out;
}
