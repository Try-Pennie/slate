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
  /**
   * Every class that paints a colour or an opacity behind a variant this scan
   * does not recognise (#2856), whole, so the sweep can fail naming it. Such a
   * class is never measured and never silently dropped.
   */
  unrecognised: string[];
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
  | { kind: "rest" }
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
  if (variants.length === 0) return { kind: "rest" };
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
  // A theme or width limit with no state is a REST variant. The rest pair has
  // never been measured behind a variant, which is a separate gap from this one.
  if (state === null || trigger === null) return { kind: "rest" };
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
 * Every interactive state a literal declares a colour or an opacity for, with the
 * rest classes filled in wherever the state does not restate them, resolved per
 * theme and per breakpoint (#2856).
 *
 * Each state variant spelling is its own trigger (hovering the control and
 * hovering its group are different moments), and for each trigger the paint is
 * resolved at every width a class limits itself to and in both themes: a class
 * with no theme variant applies in both, a `dark:` one in dark only and over the
 * unlimited one, and a min width breakpoint applies at its own width and every
 * wider one. Entries that come out identical across the two themes are merged,
 * so an unqualified `hover:` is one state measured twice, as before.
 *
 * Alongside the states it returns every painting class whose variant it could
 * not place, so the caller fails on it by name (see `parseVariantChain`).
 */
export function interactiveStates(
  literal: string,
  restBg: string,
  restFg: string,
  isColour: (token: string) => boolean,
): { states: StatePaint[]; unrecognised: string[] } {
  const colour = (utility: string, prefix: "bg" | "text") => {
    if (!utility.startsWith(`${prefix}-`)) return false;
    const c = parseColourClass(utility);
    return c !== null && (/^\w+-\[var\(/.test(utility) || isColour(c.token));
  };
  const paints = (u: string) => colour(u, "bg") || colour(u, "text") || opacityOf(u) !== null;

  type Parsed = { utility: string; state: string; trigger: string; theme: Theme | null; breakpoint: string | null };
  const parsed: Parsed[] = [];
  const unrecognised: string[] = [];
  for (const cls of literal.split(/\s+/).filter(Boolean)) {
    const { variants, utility } = splitVariants(cls);
    const chain = parseVariantChain(variants);
    if (!paints(utility)) continue;
    if (chain.kind === "unknown") unrecognised.push(cls);
    if (chain.kind !== "state") continue;
    parsed.push({ utility, state: chain.state, trigger: chain.trigger, theme: chain.theme, breakpoint: chain.breakpoint });
  }

  const out: StatePaint[] = [];
  for (const state of INTERACTIVE_STATES) {
    const triggers = [...new Set(parsed.filter((p) => p.state === state).map((p) => p.trigger))];
    for (const trigger of triggers) {
      const own = parsed.filter((p) => p.trigger === trigger);
      const widths = [null, ...[...new Set(own.map((p) => p.breakpoint).filter((b) => b !== null))]
        .sort((a, b) => breakpointRank(a) - breakpointRank(b))];
      for (const at of widths) {
        const byTheme: { theme: Theme; paint: Omit<StatePaint, "themes"> }[] = [];
        for (const theme of ["light", "dark"] as Theme[]) {
          const live = own
            .filter((p) => (p.theme === null || p.theme === theme) && appliesAt(p.breakpoint, at))
            // Later wins: a wider breakpoint over a narrower one, and within a
            // width a `dark:` class over the unlimited one.
            .sort((a, b) => breakpointRank(a.breakpoint) - breakpointRank(b.breakpoint) ||
              (a.theme === null ? 0 : 1) - (b.theme === null ? 0 : 1));
          // A width is its own entry only when something is limited to it;
          // otherwise the narrower width already measured the same paint.
          if (at !== null && !live.some((p) => p.breakpoint === at)) continue;
          if (live.length === 0) continue;
          const last = <T,>(pick: (p: Parsed) => T | null): T | null => {
            let v: T | null = null;
            for (const p of live) {
              const x = pick(p);
              if (x !== null) v = x;
            }
            return v;
          };
          const bg = last((p) => (colour(p.utility, "bg") ? p.utility : null));
          const fg = last((p) => (colour(p.utility, "text") ? p.utility : null));
          const op = last((p) => opacityOf(p.utility));
          const variant = [at, live.some((p) => p.theme === "dark") ? "dark" : null, trigger]
            .filter((x) => x !== null)
            .join(":");
          byTheme.push({ theme, paint: { state, variant, bg: bg ?? restBg, fg: fg ?? restFg, opacity: op ?? 1 } });
        }
        const same = (a: Omit<StatePaint, "themes">, b: Omit<StatePaint, "themes">) =>
          a.variant === b.variant && a.bg === b.bg && a.fg === b.fg && a.opacity === b.opacity;
        if (byTheme.length === 2 && same(byTheme[0].paint, byTheme[1].paint)) {
          out.push({ ...byTheme[0].paint, themes: ["light", "dark"] });
        } else {
          for (const t of byTheme) out.push({ ...t.paint, themes: [t.theme] });
        }
      }
    }
  }
  return { states: out, unrecognised };
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
      for (const fg of fgs) {
        const { states, unrecognised } = interactiveStates(literal, bg, fg, isColour);
        out.push({ bg, fg, literal, line, states, unrecognised });
      }
    }
  }
  return out;
}
