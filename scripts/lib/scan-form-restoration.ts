// #2718: the scan behind scripts/test-form-restoration.ts, kept beside it so the
// detector can be driven with hand written source as well as the real tree.
//
// A browser putting back form controls the person changed (on a reload in
// Safari and Firefox, on back and forward everywhere) turns a settings form
// rendered with `defaultChecked` / `defaultValue` into a liar: an UNSAVED edit
// comes back looking like the stored value, on exactly the refresh somebody does
// to check that a save took (L732). `autoComplete="off"` on the form is what
// tells the browser not to.

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
  for (const m of src.matchAll(/<form\b/g)) {
    const start = m.index ?? 0;
    // A `<form>` named in prose (a doc comment, a `//` line) is not a form.
    const lineSoFar = src.slice(src.lastIndexOf("\n", start - 1) + 1, start).trim();
    if (/^(\/\/|\/\*|\*|\{\/\*)/.test(lineSoFar)) continue;
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

/** The attribute that stops the browser restoring the form's controls. */
export const RESTORE_OFF = /\bautoComplete="off"/;

/**
 * The escape hatch: `form-restore-ok: <reason>` in the comment directly above
 * the tag. The reason must begin with a WORD, so the comment's own punctuation
 * (a closing `*\/}`) cannot pass for one (L675).
 */
const OPT_OUT = /form-restore-ok:\s*[A-Za-z]/;

/**
 * The comments directly above a tag: a run of `//` lines, or block comments
 * (`/* *\/` or JSX's `{/* *\/}`) walked back to where each one opens, so a
 * reason wrapped over several plain lines is still read whole.
 */
export function commentAbove(src: string, index: number): string {
  const lines = src.slice(0, index).split("\n");
  lines.pop(); // the tag's own line, up to the tag
  const kept: string[] = [];
  let i = lines.length - 1;
  while (i >= 0) {
    const t = lines[i]!.trim();
    if (t.startsWith("//")) {
      kept.unshift(t);
      i--;
    } else if (/\*\/\}?$/.test(t)) {
      // A block comment ends here: take lines up to the one that opens it.
      let j = i;
      while (j >= 0 && !/(\{\/\*|\/\*)/.test(lines[j]!)) j--;
      if (j < 0) break;
      kept.unshift(...lines.slice(j, i + 1).map((l) => l.trim()));
      i = j - 1;
    } else break;
  }
  return kept.join("\n");
}

/** Why a form tag is acceptable, or null when it is not. */
export function formTagVerdict(src: string, t: FormTag): "restore-off" | "opted-out" | null {
  if (RESTORE_OFF.test(t.tag)) return "restore-off";
  if (OPT_OUT.test(commentAbove(src, t.index))) return "opted-out";
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
