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
 * String literals are deliberately NOT tracked: JSX text is full of apostrophes
 * ("don't"), and treating one as a quote would hide real markup, which is the
 * dangerous direction for this guard. The cost is that `//` inside a string
 * (a URL) masks the rest of that one line, which at worst hides a form sharing a
 * line with a URL literal.
 */
export function commentMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++) mask[k] = true;
      i = stop;
    } else if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      for (let k = i; k < stop; k++) mask[k] = true;
      i = stop;
    } else i++;
  }
  return mask;
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
