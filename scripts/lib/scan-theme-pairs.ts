/**
 * The scan behind `scripts/test-theme-pairs.ts` (#2007).
 *
 * Separate from the guard so the decision logic can be driven by hand written
 * fixtures, including ones it must CATCH, which a run over the real tree can
 * never demonstrate once the tree is clean: a scanner that finds nothing and a
 * clean tree produce the same empty result (L98).
 */

export interface ThemePairFinding {
  file: string;
  line: number;
  text: string;
  why: string;
}

/**
 * Backgrounds that are the SAME COLOUR IN BOTH THEMES on purpose.
 *
 * A status wash must not change meaning when somebody flips the theme, and the
 * navy band is the brand's own dark surface whichever theme the page is in. That
 * is exactly what makes them dangerous: the foreground next to them must be
 * equally fixed, or it flips out from under a background that did not move.
 *
 * Read from the class name rather than the token file, because a call site can
 * spell one either way (`bg-pennie-sky-soft` or `bg-[var(--pennie-sky-soft)]`).
 */
export const RAW_SURFACES = [
  "pennie-green-wash",
  "pennie-green-deep",
  "pennie-sky-soft",
  "pennie-sky",
  "pennie-navy",
  "pennie-ink",
  "pennie-rose",
  "pennie-yellow",
  "pennie-beige",
  "pennie-wild-sand",
  "pennie-mercury",
];

/** Foregrounds that FLIP with the theme. These are the ones that must not sit on
 *  a fixed background without a per-theme override. */
const FLIPPING = new Set(["text-fg", "text-fg-muted", "text-error"]);

/**
 * One class, split into the STATE it applies in and the utility itself.
 *
 * `peer-checked:bg-pennie-sky` applies only while checked, and
 * `peer-checked:text-pennie-graphite` beside it is the text for that same state.
 * Reading the line as a flat bag pairs the sky with the RESTING `text-fg-muted`
 * and reports a control whose checked state is entirely correct. That was the
 * scanner's second mistake, and `DayToggles` was the file that showed it.
 */
function split(cls: string): { state: string; util: string } {
  const at = cls.lastIndexOf(":");
  return at < 0 ? { state: "", util: cls } : { state: cls.slice(0, at), util: cls.slice(at + 1) };
}

/** The raw surface a class paints, or null. Either spelling. */
function rawSurfaceOf(util: string): string | null {
  for (const token of RAW_SURFACES) {
    if (util === `bg-${token}`) return token;
    if (util === `bg-[var(--${token})]`) return token;
  }
  return null;
}

/**
 * Is this `text-*` a COLOUR, or typography?
 *
 * `text-sm` and `text-fg` are both `text-`, and reading the first one found made
 * the scanner answer "text-sm" for the resting colour and then find nothing
 * flipping. It reported the exact defect that shipped as clean, which is the
 * direction that gets a guard trusted while it protects nothing (L98). Its own
 * positive control is what caught it.
 */
function isTextColour(util: string): boolean {
  if (!util.startsWith("text-")) return false;
  if (FLIPPING.has(util)) return true;
  if (util.startsWith("text-pennie-")) return true;
  if (util.startsWith("text-[")) return true;
  return /^text-(accent|surface|fg-on-sky|error|white|black)\b/.test(util);
}

/**
 * The text COLOUR that applies while a given state is active.
 *
 * A colour set for that exact state wins; otherwise the resting one still
 * applies, because nothing overrode it. That second half matters: `text-fg
 * hover:bg-pennie-sky-soft` really is the flipping colour sitting on the fixed
 * wash for as long as the pointer is there.
 */
function textInState(classes: string[], state: string): string | null {
  let resting: string | null = null;
  for (const c of classes) {
    const { state: st, util } = split(c);
    if (!isTextColour(util)) continue;
    if (st === state && state !== "") return util;
    if (st === "") resting = util;
  }
  return resting;
}

/** Whether either half of this pair is given a per theme value. */
function hasThemeOverride(classes: string[], state: string): boolean {
  for (const c of classes) {
    if (!/(^|:)dark:/.test(c) && !c.startsWith("dark:")) continue;
    const { util } = split(c);
    if (!util.startsWith("bg-") && !util.startsWith("text-")) continue;
    const rest = c.replace(/^dark:/, "");
    const { state: st } = split(rest);
    // The override must cover the same state, or the resting one, which applies
    // wherever nothing else does.
    if (st === state || st === "") return true;
  }
  return false;
}

/** A `// theme-pair-ok: <reason>` on, or in the comment block directly above,
 *  a line. The reason is required: an exemption with none is evidence nobody
 *  reasoned about it (L233). */
export function exemptionAbove(lines: string[], at: number): string | null {
  for (let i = at; i >= 0 && i > at - 10; i--) {
    const m = lines[i].match(/(?:\/\/|\*)\s*theme-pair-ok:\s*(.+?)\s*(?:\*\/)?$/);
    if (m) return m[1].trim();
    const t = lines[i].trim();
    if (i !== at && t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) {
      return null;
    }
  }
  return null;
}

/**
 * Findings for one file.
 *
 * A line is compliant when it also carries a `dark:` override for either half,
 * because that is the design the booker's palette uses and it is correct: change
 * the background per theme, or change the text per theme, but do not leave one
 * fixed and the other flipping.
 */
export function findThemePairs(file: string, src: string): ThemePairFinding[] {
  const lines = src.split("\n");
  const out: ThemePairFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classes = line.match(/[A-Za-z][\w:./[\]()-]*/g) ?? [];
    for (const cls of classes) {
      const { state, util } = split(cls);
      const token = rawSurfaceOf(util);
      if (!token) continue;
      const text = textInState(classes, state);
      if (!text || !FLIPPING.has(text)) continue;
      if (hasThemeOverride(classes, state)) continue;
      if (exemptionAbove(lines, i)) continue;
      out.push({
        file,
        line: i + 1,
        text: line.trim().slice(0, 120),
        why: `${text} flips with the theme on --${token}${state ? ` (${state})` : ""}, which does not`,
      });
      break;
    }
  }
  return out;
}

/** An exemption with no real reason. */
export function findReasonlessExemptions(file: string, src: string): ThemePairFinding[] {
  const out: ThemePairFinding[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/theme-pair-ok:\s*(.*)$/);
    if (m && m[1].replace(/\*\/\s*$/, "").trim().length < 12) {
      out.push({ file, line: i + 1, text: lines[i].trim(), why: "exemption with no real reason" });
    }
  }
  return out;
}
