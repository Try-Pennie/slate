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

/** The two themes the tokens are declared in (`:root` and `[data-theme="dark"]`). */
export type Theme = "light" | "dark";

export type ClassPair = {
  /**
   * The background class of the pair's first rest entry, for naming, or of its
   * first state when the literal paints no opaque rest pair at all.
   */
  bg: string;
  /** The text class chosen the same way as `bg`. */
  fg: string;
  /** The whole literal, so a failure can be found by searching for it. */
  literal: string;
  /** 1 based line of the literal's opening quote. */
  line: number;
  /**
   * What the control paints AT REST, per theme and per width (#2866). An
   * unprefixed pair is one entry measured in both themes; a `dark:text-white`,
   * an `md:bg-white` or a `dark:opacity-60` makes the theme or width it applies
   * in its own entry, because that is a different pair somebody reads.
   */
  rest: RestPaint[];
  /**
   * What the same control paints in each INTERACTIVE state the literal declares
   * (#2836). The rest pair is not the only pair a person reads: a pointer resting
   * on the button is in the hover state at the moment of pressing, and a keyboard
   * user is in the focus state. A state that restates neither colour inherits the
   * rest one of its own theme and width, so every entry is a complete pair.
   */
  states: StatePaint[];
  /**
   * Every class that paints a colour or an opacity behind a variant this scan
   * does not recognise (#2856), whole, so the sweep can fail naming it. Such a
   * class is never measured and never silently dropped.
   */
  unrecognised: string[];
  /**
   * Every measurement this pair could not take, each naming the state, the
   * theme and why (#2866). A state with its own complete fill and label is
   * always measured for its own contrast; what lands here is the part that
   * needed something the literal does not hold, most often the step from a
   * rest fill in a theme whose rest is a wash or paints no fill. Reported so a
   * reader can see what the sweep did NOT judge, never dropped in silence (L98).
   */
  unmeasured: string[];
};

/** The rest paint of a rose pairing, in the themes and at the width it applies. */
export type RestPaint = {
  /** `rest`, or the variants limiting it (`dark`, `md`, `md:dark`), for naming. */
  variant: string;
  /** The themes this paint applies in. */
  themes: Theme[];
  /** The opaque background colour class. */
  bg: string;
  /** The opaque text colour class. */
  fg: string;
  /** The element's rest opacity, 1 when none is declared. */
  opacity: number;
};

/** One interactive state of a rose pairing, resolved to a complete paint. */
export type StatePaint = {
  /** The state measured (`hover`, `focus`, `focus-visible`, `active`). */
  state: string;
  /**
   * The variant chain that produces this paint (`hover`, `dark:hover`,
   * `md:hover`, `group-hover`, `md:dark:hover`), for naming a failure.
   */
  variant: string;
  /** The themes this paint applies in. A `dark:` variant applies in dark only. */
  themes: Theme[];
  /** The background colour class in that state, unprefixed, alpha included. */
  bg: string;
  /** The text colour class in that state, unprefixed, alpha included. */
  fg: string;
  /**
   * The rest fill this state steps from, in the same theme and at the same
   * width, so a recoloured state can be judged a visible step from it (#2866).
   * Null when that theme has no opaque rest fill: the state's own contrast is
   * still measured, and only the step is not, which `unmeasured` says.
   */
  restBg: string | null;
  /**
   * The element's opacity in that state, 1 when none is declared. Anything below
   * 1 fades the fill AND the label over whatever is behind the control, so the
   * pair can only be measured once it is composited over a real background.
   */
  opacity: number;
};

/**
 * The interactive states measured, each with the variant spellings that trigger
 * it. `group-*` and `peer-*` put the control in the state because of a
 * neighbour, which changes WHAT the person points at, not what they read, so
 * they are the same state; `focus-within` is a focus the control is showing.
 * `disabled:` is deliberately absent: WCAG 1.4.3 exempts an inactive control,
 * and `disabled:opacity-60` is how every button here says it cannot be pressed.
 */
const INTERACTIVE_STATES = ["hover", "focus", "focus-visible", "active"];
const STATE_OF: Record<string, string> = {
  hover: "hover",
  focus: "focus",
  "focus-within": "focus",
  "focus-visible": "focus-visible",
  active: "active",
};

/** Min width breakpoints in cascade order: `lg:` also applies at `xl`. */
const BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"];

/** Split a class on its variant colons, leaving colons inside `[...]` alone. */
function splitVariants(cls: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cls) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  return { variants: parts, utility: cur };
}

/** A class's variant chain, read as what it means for measuring contrast. */
type Chain =
  | {
      kind: "rest";
      /** Null for every theme, else the one theme the chain is limited to. */
      theme: Theme | null;
      /** Null for every width, else the breakpoint variant it is limited to. */
      breakpoint: string | null;
    }
  | { kind: "exempt" }
  | { kind: "unknown" }
  | {
      kind: "state";
      state: string;
      /** The literal state variant (`hover`, `group-hover/row`), which is its trigger. */
      trigger: string;
      /** Null for every theme, else the one theme the chain is limited to. */
      theme: Theme | null;
      /** Null for every width, else the breakpoint variant it is limited to. */
      breakpoint: string | null;
    };

/**
 * Read a variant chain. What a variant I do not recognise means is decided
 * here, and the decision is to REPORT it rather than guess. Measuring it
 * "conservatively in both themes" would treat `placeholder:`, `aria-invalid:`
 * or `data-[state=open]:` as a hover of the whole control, which is a claim
 * about a paint nobody reads that way, while dropping it is the very blind spot
 * #2856 was opened about. A named failure costs one line in this function the
 * first time a new shape appears, and after that the shape is measured properly.
 */
function parseVariantChain(variants: string[]): Chain {
  if (variants.length === 0) return { kind: "rest", theme: null, breakpoint: null };
  let state: string | null = null;
  let trigger: string | null = null;
  let theme: Theme | null = null;
  let breakpoint: string | null = null;
  for (const v of variants) {
    if (/(^|-)disabled$/.test(v)) return { kind: "exempt" };
    if (v === "dark") {
      theme = "dark";
      continue;
    }
    if (
      BREAKPOINTS.includes(v) ||
      /^max-(sm|md|lg|xl|2xl)$/.test(v) ||
      /^(min|max)-\[[^\]]+\]$/.test(v) ||
      /^@(max-)?(3xs|2xs|xs|sm|md|lg|xl|[2-7]xl)$/.test(v)
    ) {
      // Two width limits on one class is a shape this cannot place.
      if (breakpoint !== null) return { kind: "unknown" };
      breakpoint = v;
      continue;
    }
    const s = v.match(/^(?:(?:group|peer)-)?(hover|focus|focus-within|focus-visible|active)(?:\/[\w-]+)?$/);
    if (s) {
      // `hover:focus:` needs both at once; nothing here writes it, so say so.
      if (state !== null) return { kind: "unknown" };
      state = STATE_OF[s[1]];
      trigger = v;
      continue;
    }
    return { kind: "unknown" };
  }
  // A theme or width limit with no state is a REST variant, measured as the rest
  // pair of the theme and width it names (#2866).
  if (state === null || trigger === null) return { kind: "rest", theme, breakpoint };
  return { kind: "state", state, trigger, theme, breakpoint };
}

/** Where a breakpoint sits in the cascade, -1 for no breakpoint. */
function breakpointRank(bp: string | null): number {
  if (bp === null) return -1;
  const i = BREAKPOINTS.indexOf(bp);
  return i === -1 ? BREAKPOINTS.length : i;
}

/** Whether a class limited to `bp` applies at the width `at` stands for. */
function appliesAt(bp: string | null, at: string | null): boolean {
  if (bp === null) return true;
  if (at === null) return false;
  if (BREAKPOINTS.includes(bp) && BREAKPOINTS.includes(at)) return breakpointRank(bp) <= breakpointRank(at);
  return bp === at;
}

function opacityOf(utility: string): number | null {
  const n = utility.match(/^opacity-(\d+)$/);
  if (n) return Number(n[1]) / 100;
  const a = utility.match(/^opacity-\[(0?\.\d+|1|\d+%)\]$/);
  if (a) return a[1].endsWith("%") ? Number(a[1].slice(0, -1)) / 100 : Number(a[1]);
  return null;
}

/**
 * `bg-error/60` -> `{ token: "--error", alpha: 0.6 }`, `text-white` ->
 * `{ token: "--pennie-white", alpha: 1 }`. The alpha form is how a STATE may
 * paint a translucent fill, which is measurable once composited over a surface;
 * the rest pair keeps refusing it through `tokenForColourClass`. Null for
 * anything that is not a colour class this can resolve.
 */
export function parseColourClass(cls: string): { token: string; alpha: number } | null {
  const m = cls.match(/^((?:bg|text)-.+?)(?:\/(?:(\d+)|\[(0?\.\d+|1(?:\.0+)?)\]))?$/);
  if (!m) return null;
  const token = tokenForColourClass(m[1]);
  if (token === null) return null;
  const alpha = m[2] !== undefined ? Number(m[2]) / 100 : m[3] !== undefined ? Number(m[3]) : 1;
  if (!(alpha > 0 && alpha <= 1)) return null;
  return { token, alpha };
}

/** The token that paints the rose, in either half, at any alpha. */
const ROSE_TOKEN = "--error";

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

/** One class of a literal, with what its variant chain means. */
type Parsed = { cls: string; utility: string; chain: Chain };
type Limited = { utility: string; theme: Theme | null; breakpoint: string | null };

/**
 * The classes that apply in `theme` at the width `at` stands for, in cascade
 * order, later winning: a wider breakpoint over a narrower one, and within a
 * width a `dark:` class over the unlimited one. The same order for the rest and
 * for every state, so the two can never resolve one literal differently.
 */
function liveIn<T extends Limited>(classes: T[], theme: Theme, at: string | null): T[] {
  return classes
    .filter((p) => (p.theme === null || p.theme === theme) && appliesAt(p.breakpoint, at))
    .sort((a, b) => breakpointRank(a.breakpoint) - breakpointRank(b.breakpoint) ||
      (a.theme === null ? 0 : 1) - (b.theme === null ? 0 : 1));
}

/** Every literal in `src` that paints the rose, with its rest and state pairs. */
export function scanRosePairings(src: string, isColour: (token: string) => boolean): ClassPair[] {
  const out: ClassPair[] = [];
  const literalRe = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  for (const m of src.matchAll(literalRe)) {
    const literal = m[2];
    const before = src.slice(0, m.index ?? 0);
    // A literal on a COMMENT line (one opening with `//`, `/*` or a JSDoc `*`)
    // describes a class string rather than painting one, so it is not a pairing
    // anything draws. It matters since #2866 measures a state with no rest pair:
    // a comment quoting a retired treatment then read as a live failure. A
    // literal after code on the same line is still scanned, so a trailing
    // comment is not exempt by this rule.
    const lineStart = before.slice(before.lastIndexOf("\n") + 1);
    if (/^\s*(\/\/|\/\*|\*)/.test(lineStart)) continue;
    const line = before.split("\n").length;
    out.push(...pairsOfLiteral(literal, line, isColour));
  }
  return out;
}

/**
 * The rose pairings one literal holds.
 *
 * A literal is a rose pairing when ANY class it carries paints the rose, whatever
 * variant it sits behind (#2866): `bg-surface text-fg hover:bg-[var(--error)]`
 * puts a label on the rose at the moment of pressing, and reading the rose only
 * from unprefixed classes left that hover unfound and so unmeasured.
 *
 * The REST pair is then resolved per theme and per width through the same
 * variant chain parser and the same cascade the states use, so `dark:text-white`
 * on the rose is measured as the dark pair it is. A rest fill must be opaque: a
 * wash (`bg-error/25`) has a different colour on every page and is refused as a
 * rest fill, as it always was. When a wash WINS the cascade in a theme, that
 * theme's rest is not a measurable pair, and the unlimited fill beneath it does
 * not answer for it: a fallback to the class the wash overrides would measure a
 * paint nobody sees there. A theme with no rest fill or no rest label at all
 * (the parent paints it) is likewise not measured, since the pair is not in the
 * literal to read.
 *
 * A text class is only a colour if `isColour` says its token exists, which is how
 * `text-sm` and `text-center` are told from `text-fg` without a list of sizes. An
 * explicit `[var(--x)]` is a colour by construction, so it is always kept and a
 * misspelt token THROWS when measured rather than being skipped (L11).
 */
function pairsOfLiteral(literal: string, line: number, isColour: (token: string) => boolean): ClassPair[] {
  const colour = (utility: string, prefix: "bg" | "text") => {
    if (!utility.startsWith(`${prefix}-`)) return false;
    const c = parseColourClass(utility);
    return c !== null && (/^\w+-\[var\(/.test(utility) || isColour(c.token));
  };
  const paints = (u: string) => colour(u, "bg") || colour(u, "text") || opacityOf(u) !== null;
  const isRose = (u: string) => (colour(u, "bg") || colour(u, "text")) && parseColourClass(u)?.token === ROSE_TOKEN;

  const parsed: Parsed[] = literal
    .split(/\s+/)
    .filter(Boolean)
    .map((cls) => {
      const { variants, utility } = splitVariants(cls);
      return { cls, utility, chain: parseVariantChain(variants) };
    });
  if (!parsed.some((p) => p.chain.kind !== "exempt" && isRose(p.utility))) return [];

  const unrecognised = parsed.filter((p) => p.chain.kind === "unknown" && paints(p.utility)).map((p) => p.cls);
  const rest: Limited[] = [];
  type StateClass = Limited & { state: string; trigger: string };
  const stated: StateClass[] = [];
  for (const p of parsed) {
    if (!paints(p.utility)) continue;
    if (p.chain.kind === "rest") rest.push({ utility: p.utility, theme: p.chain.theme, breakpoint: p.chain.breakpoint });
    if (p.chain.kind === "state") {
      stated.push({
        utility: p.utility,
        theme: p.chain.theme,
        breakpoint: p.chain.breakpoint,
        state: p.chain.state,
        trigger: p.chain.trigger,
      });
    }
  }

  // The rest cell at one width in one theme. The winning cascade level for each
  // half is the last one carrying a class of that half; its OPAQUE classes are
  // the candidates, so two fills written on one literal (a conflict whose
  // winner is stylesheet order, not class order) are both measured.
  const widthsOf = (cls: Limited[]) =>
    [...new Set(cls.map((p) => p.breakpoint).filter((b): b is string => b !== null))]
      .sort((a, b) => breakpointRank(a) - breakpointRank(b));
  const levelKey = (p: Limited) => `${breakpointRank(p.breakpoint)}|${p.theme ?? ""}`;
  const candidates = (live: Limited[], prefix: "bg" | "text") => {
    const half = live.filter((p) => colour(p.utility, prefix));
    if (half.length === 0) return [];
    const top = levelKey(half[half.length - 1]);
    return half.filter((p) => levelKey(p) === top && tokenForColourClass(p.utility) !== null).map((p) => p.utility);
  };
  type Cell = { at: string | null; theme: Theme; bgs: string[]; fgs: string[]; opacity: number; dark: boolean };
  const cellAt = (at: string | null, theme: Theme): Cell => {
    const live = liveIn(rest, theme, at);
    let opacity = 1;
    for (const p of live) opacity = opacityOf(p.utility) ?? opacity;
    return {
      at,
      theme,
      bgs: candidates(live, "bg"),
      fgs: candidates(live, "text"),
      opacity,
      dark: live.some((p) => p.theme === "dark"),
    };
  };
  const restCells: Cell[] = [];
  for (const at of [null, ...widthsOf(rest)]) {
    for (const theme of ["light", "dark"] as Theme[]) {
      const cell = cellAt(at, theme);
      // A width is its own entry only when a rest class is limited to it;
      // otherwise the narrower width already measured the same paint.
      if (at !== null && !liveIn(rest, theme, at).some((p) => p.breakpoint === at)) continue;
      if (cell.bgs.length > 0 && cell.fgs.length > 0) restCells.push(cell);
    }
  }

  // One pair per candidate choice, the i-th fill and the j-th label, with a cell
  // holding fewer candidates keeping its last: for the unprefixed classes alone
  // that is the cross product the scan has always produced.
  // With no rest cell at all there is still one pair to build: the states may
  // paint complete pairs of their own.
  const nb = Math.max(1, ...restCells.map((c) => c.bgs.length));
  const nf = Math.max(1, ...restCells.map((c) => c.fgs.length));
  const pick = (xs: string[], i: number) => xs[Math.min(i, xs.length - 1)] ?? null;
  const variantOf = (at: string | null, dark: boolean, tail: string | null) =>
    [at, dark ? "dark" : null, tail].filter((x) => x !== null).join(":");

  const pairs: ClassPair[] = [];
  for (let i = 0; i < nb; i++) {
    for (let j = 0; j < nf; j++) {
      const restPaints = mergeThemes(
        restCells.map((c) => ({
          theme: c.theme,
          paint: { variant: variantOf(c.at, c.dark, null) || "rest", bg: pick(c.bgs, i)!, fg: pick(c.fgs, j)!, opacity: c.opacity },
        })),
        (a, b) => a.variant === b.variant && a.bg === b.bg && a.fg === b.fg && a.opacity === b.opacity,
      );
      const { states, unmeasured } = statePaints(
        stated, rest, widthsOf, cellAt, (c) => pick(c.bgs, i), (c) => pick(c.fgs, j), colour, variantOf,
      );
      // A literal with no rest pair and no state it could build is a rose mark
      // with its fill painted elsewhere (a bare `text-error`), not a pairing.
      if (restPaints.length === 0 && states.length === 0 && unmeasured.length === 0) continue;
      const named = restPaints[0] ?? states[0];
      pairs.push({
        bg: named?.bg ?? "",
        fg: named?.fg ?? "",
        literal,
        line,
        rest: restPaints,
        states,
        unrecognised,
        unmeasured,
      });
    }
  }
  return pairs;
}

/**
 * Entries identical across the two themes become one entry measured in both,
 * so an unqualified class is one paint measured twice, as it always was.
 * Entries are merged only with their neighbour of the other theme at the same
 * width, which is how they are produced.
 */
function mergeThemes<P>(byTheme: { theme: Theme; paint: P }[], same: (a: P, b: P) => boolean): (P & { themes: Theme[] })[] {
  const out: (P & { themes: Theme[] })[] = [];
  for (let k = 0; k < byTheme.length; k++) {
    const a = byTheme[k];
    const b = byTheme[k + 1];
    if (a.theme === "light" && b?.theme === "dark" && same(a.paint, b.paint)) {
      out.push({ ...a.paint, themes: ["light", "dark"] });
      k++;
    } else out.push({ ...a.paint, themes: [a.theme] });
  }
  return out;
}

/**
 * Every interactive state a literal declares a colour or an opacity for, with the
 * rest paint of the same theme and width filled in wherever the state does not
 * restate it (#2836, #2856, #2866).
 *
 * Each state variant spelling is its own trigger (hovering the control and
 * hovering its group are different moments), and for each trigger the paint is
 * resolved at every width a state OR rest class limits itself to, in both
 * themes. A state class beats a rest class whatever variants either carries:
 * the state's pseudo class gives it the higher specificity, and the `dark:`
 * variant here adds none (`:where`).
 *
 * A state is measured for its OWN contrast whenever its fill and label can be
 * resolved, from its own classes or the rest of its theme and width, whether or
 * not that theme has a rest pair. Two things are not measured, and each is
 * reported on `unmeasured` rather than dropped: a whole state whose fill or
 * label the literal does not hold in that theme (neither the state nor the rest
 * paints it), and, for a state with its own fill, the step from rest in a theme
 * with no opaque rest fill (`restBg` null), since there is nothing to step from.
 */
function statePaints(
  stated: (Limited & { state: string; trigger: string })[],
  rest: Limited[],
  widthsOf: (cls: Limited[]) => string[],
  cellAt: (at: string | null, theme: Theme) => { bgs: string[]; fgs: string[]; opacity: number; dark: boolean },
  restBgOf: (c: { bgs: string[] }) => string | null,
  restFgOf: (c: { fgs: string[] }) => string | null,
  colour: (u: string, prefix: "bg" | "text") => boolean,
  variantOf: (at: string | null, dark: boolean, tail: string | null) => string,
): { states: StatePaint[]; unmeasured: string[] } {
  const out: StatePaint[] = [];
  const unmeasured: string[] = [];
  for (const state of INTERACTIVE_STATES) {
    const triggers = [...new Set(stated.filter((p) => p.state === state).map((p) => p.trigger))];
    for (const trigger of triggers) {
      const own = stated.filter((p) => p.trigger === trigger);
      const widths = [null, ...widthsOf([...own, ...rest]).sort((a, b) => breakpointRank(a) - breakpointRank(b))];
      for (const at of [...new Set(widths)]) {
        const byTheme: { theme: Theme; paint: Omit<StatePaint, "themes"> }[] = [];
        for (const theme of ["light", "dark"] as Theme[]) {
          const live = liveIn(own, theme, at);
          if (live.length === 0) continue;
          if (at !== null && !live.some((p) => p.breakpoint === at) && !liveIn(rest, theme, at).some((p) => p.breakpoint === at)) {
            continue;
          }
          const last = <T,>(pickOne: (p: Limited) => T | null): T | null => {
            let v: T | null = null;
            for (const p of live) {
              const x = pickOne(p);
              if (x !== null) v = x;
            }
            return v;
          };
          const cell = cellAt(at, theme);
          const restBg = restBgOf(cell);
          const bg = last((p) => (colour(p.utility, "bg") ? p.utility : null)) ?? restBg;
          const fg = last((p) => (colour(p.utility, "text") ? p.utility : null)) ?? restFgOf(cell);
          const dark = live.some((p) => p.theme === "dark") || cell.dark;
          const variant = variantOf(at, dark, trigger);
          if (bg === null || fg === null) {
            const missing = bg === null ? "fill" : "label";
            unmeasured.push(`${variant} (${theme}): not measured, the literal paints no ${missing} for it in this theme`);
            continue;
          }
          if (restBg === null) {
            unmeasured.push(`${variant} (${theme}): step from rest not measured, this theme has no opaque rest fill`);
          }
          const op = last((p) => opacityOf(p.utility)) ?? cell.opacity;
          byTheme.push({ theme, paint: { state, variant, bg, fg, restBg, opacity: op } });
        }
        out.push(
          ...mergeThemes(byTheme, (a, b) =>
            a.variant === b.variant && a.bg === b.bg && a.fg === b.fg && a.restBg === b.restBg && a.opacity === b.opacity),
        );
      }
    }
  }
  return { states: out, unmeasured };
}
