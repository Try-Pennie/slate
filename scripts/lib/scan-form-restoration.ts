// #2718: the scan behind scripts/test-form-restoration.ts, kept beside it so the
// detector can be driven with hand written source as well as the real tree.
//
// A browser putting back form controls the person changed (on a reload in
// Safari and Firefox, on back and forward everywhere) turns a settings form
// rendered with `defaultChecked` / `defaultValue` into a liar: an UNSAVED edit
// comes back looking like the stored value, on exactly the refresh somebody does
// to check that a save took (L732). `autoComplete="off"` on the form is what
// tells the browser not to.

import { hasOptOutAtOffset } from "./opt-out.ts";

/** One `<form ...>` opening tag in a file, with where it starts. */
export type FormTag = { tag: string; index: number; line: number };

/**
 * Every `<form` opening tag, scanned to the closing `>` at brace depth zero.
 *
 * Scanned rather than matched to the first `>`, because an arrow function in an
 * `onSubmit={(e) => ...}` holds a `>` well before the tag ends, and a fixed span
 * from the anchor stops containing the attribute the moment a comment is added
 * inside the tag (L518).
 */
export function formTags(src: string): FormTag[] {
  const out: FormTag[] = [];
  const inComment = commentMask(src);
  for (const m of src.matchAll(/<form\b/g)) {
    const start = m.index ?? 0;
    // A `<form>` named in prose (a doc comment, a `//` line, ANY line of a block
    // comment, not only the one that opens it) is not a form.
    if (inComment[start]) continue;
    let depth = 0;
    for (let i = start + "<form".length; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        out.push({ tag: src.slice(start, i + 1), index: start, line: src.slice(0, start).split("\n").length });
        break;
      }
    }
  }
  return out;
}

/**
 * Which characters of `src` sit inside a comment, walked once from the top.
 *
 * Tracked as STATE rather than judged per line, because a continuation line of a
 * `/* ... *\/` or JSX `{/* ... *\/}` block carries no marker of its own, and a
 * per line prefix check reads prose there as markup. A `//` line is skipped to
 * its end, so a line comment that merely names `/*` cannot open a block that
 * swallows the rest of the file.
 *
 * String, template and regex literals are skipped too (#2768): a `/*` inside a
 * URL, a glob or a regex used to open a block that masked everything up to the
 * next star slash, so a bare form further down the file was never judged. A
 * literal only ever STOPS a comment opening inside it; its own text is never
 * masked, so misreading one can hide at most a comment's prose, never markup.
 *
 * Two readings keep JSX text from being mistaken for a literal, which is the
 * dangerous direction for this guard:
 *   - an apostrophe straight after a letter or digit ("don't", "agents'") never
 *     opens a string, and a quote with no partner on its own line was never an
 *     opener, so nothing past that line is affected;
 *   - a slash after `<`, `>` (other than an arrow's `=>`) or `}` is never a regex, because `</p>` and
 *     `{price}/mo` are everywhere in JSX and a regex in those positions is rare.
 *     A regex there is read as division, which at worst leaves a `/*` inside it
 *     opening a comment, the behaviour before #2768.
 *
 * Out of scope, and named so a green run is not read as more than it is: JSX
 * TEXT that itself contains a slash star (`<code>/api/*</code>`) still opens a
 * comment, because nothing short of a parser tells JSX text from code.
 *
 * No shared helper in `scripts/lib` could be reused: each of the existing masks
 * opens a string on any apostrophe or runs an unclosed quote across lines, and
 * none reads regex literals.
 */
export function commentMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  const n = src.length;
  // One entry per open template: the brace depth inside its current `${`
  // expression, or -1 while reading the template's own text.
  const templates: number[] = [];
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const top = templates.length - 1;
    if (top >= 0 && templates[top] === -1) {
      if (c === "\\") i += 2;
      else if (c === "`") {
        templates.pop();
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        templates[top] = 0;
        i += 2;
      } else i++;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) mask[k] = true;
      i = stop;
    } else if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      for (let k = i; k < stop; k++) mask[k] = true;
      i = stop;
    } else if (c === "`") {
      templates.push(-1);
      i++;
    } else if (top >= 0 && (c === "{" || c === "}")) {
      if (c === "{") templates[top] = templates[top]! + 1;
      else if (templates[top] === 0) templates[top] = -1;
      else templates[top] = templates[top]! - 1;
      i++;
    } else if (c === '"' || (c === "'" && !WORD_CHAR.test(src[i - 1] ?? ""))) {
      i = quotedEnd(src, i);
    } else if (c === "/" && regexMayStart(src, i)) {
      i = regexEnd(src, i);
    } else i++;
  }
  return mask;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/** Past the string opened at `i`, or just past the quote when it never closes on its own line. */
function quotedEnd(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === q) return j + 1;
    else if (c === "\n") break;
  }
  return i + 1;
}

/** Keywords after which a `/` begins a regex rather than a division. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "void", "in", "of", "delete", "throw", "yield", "await", "instanceof", "new", "else", "do",
]);

/** Whether a `/` at `i` begins a regex, judged by the last thing before it. */
function regexMayStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  if (j < 0) return true;
  const p = src[j]!;
  if ("(,=:[!&|?{;+-*%~^".includes(p)) return true;
  // The `>` of an arrow (`x => /a/`) opens an expression, unlike a JSX tag's `>`.
  if (p === ">" && src[j - 1] === "=") return true;
  if (!/[A-Za-z_$]/.test(p)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k]!)) k--;
  return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
}

/** Past the regex opened at `i`, or just past the slash when it never closes on its own line. */
function regexEnd(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "\n") break;
    else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "/") return j + 1;
  }
  return i + 1;
}

/** The attribute that stops the browser restoring the form's controls. */
export const RESTORE_OFF = /\bautoComplete="off"/;

/**
 * The escape hatch: `form-restore-ok: <reason>` in the comment directly above
 * the tag, read through the shared reader so a marker with no reason is not an
 * exemption and the comment forms agree with every other guard's (L675).
 */
export const OPT_OUT_TOKEN = "form-restore-ok:";

/** Why a form tag is acceptable, or null when it is not. */
export function formTagVerdict(src: string, t: FormTag): "restore-off" | "opted-out" | null {
  if (RESTORE_OFF.test(t.tag)) return "restore-off";
  if (hasOptOutAtOffset(src, t.index, OPT_OUT_TOKEN)) return "opted-out";
  return null;
}

/**
 * Whether `autoComplete="off"` in the wrapper's own `<form>` comes AFTER the
 * props it spreads, so no call site can pass its way back to restoration.
 */
export function restoreOffWinsOverSpread(tag: string): boolean {
  const spread = tag.indexOf("{...rest}");
  const off = tag.search(RESTORE_OFF);
  return off >= 0 && (spread < 0 || off > spread);
}
