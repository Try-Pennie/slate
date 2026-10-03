// Finds a `<label>` that names nothing (#3080).
//
// A label gives a control its accessible name, and makes clicking the visible
// text focus the field, only when it is ASSOCIATED with it: by `htmlFor`
// pointing at the control's id, or by wrapping the control. A bare
// `<label>Role</label>` sitting above a field does neither, so the control is
// unnamed unless somebody also remembered an `aria-label` repeating the text,
// which is two facts about one field with nothing holding them together (#1950).
//
// The shape recurred across about ten admin forms after #1950 fixed it in one
// component, which is why this is a scan over all of `src/` and not a fix to the
// sites found that day (L613).
//
// A caption for something that is NOT a single control (a value shown in a
// `<code>`, a group of inputs) is not a label, and the fix there is a `<p>`, a
// `<dt>` or a heading rather than an exemption.

/** Controls a wrapping label associates with: the native ones, plus the design
 *  system's select, whose trigger is a labelable button. */
const WRAPPED_CONTROL = /<(?:input|select|textarea|SelectField)\b/;

export type BareLabel = { line: number; tag: string };

/** Comments blanked in place, so a docstring QUOTING a bare label is not read as
 *  one (L361) and line numbers survive. A `//` is only a comment at the start of
 *  a line, so a URL in a string is left alone. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/** Index just past the `>` closing the opening tag that starts at `from`, with
 *  `>` inside a `{...}` expression (an arrow, a comparison) skipped. */
function openingTagEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
}

export function findBareLabels(source: string): BareLabel[] {
  const text = stripComments(source);
  const out: BareLabel[] = [];
  for (const m of text.matchAll(/<label(?=[\s>])/g)) {
    const start = m.index;
    const end = openingTagEnd(text, start);
    if (end < 0) continue;
    const tag = text.slice(start, end);
    const line = text.slice(0, start).split("\n").length;
    if (/\bhtmlFor\s*=/.test(tag)) continue;
    if (/\/\s*>$/.test(tag)) {
      out.push({ line, tag: tag.replace(/\s+/g, " ") });
      continue;
    }
    const close = text.indexOf("</label>", end);
    const body = close < 0 ? "" : text.slice(end, close);
    if (WRAPPED_CONTROL.test(body)) continue;
    out.push({ line, tag: tag.replace(/\s+/g, " ") });
  }
  return out;
}
