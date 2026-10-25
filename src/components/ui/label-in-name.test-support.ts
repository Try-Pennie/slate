/**
 * Label in name (WCAG 2.5.3, lesson L786, #3917).
 *
 * A control whose accessible name is set apart from its visible text (an
 * `aria-label` or `aria-labelledby` on a button or link) must have a name that
 * CONTAINS those visible words, because somebody driving by voice says what they
 * can see ("click Remove", "click AD"), and a name that replaced those words is
 * one the voice software cannot match. Extra context goes around the visible
 * words, never instead of them.
 *
 * This reads what a person sees: every text node inside the control, including
 * text hidden from assistive technology with `aria-hidden` (it is still drawn),
 * but not text that is only for screen readers (`.sr-only`) or not drawn at all
 * (`hidden`). Only WORDS count, runs of letters and digits, so a drawn glyph such
 * as a cross or an arrow is not something a person could say.
 *
 * Returns one sentence per control that breaks the rule, so an assertion of `[]`
 * names every offender when it fails.
 */

/** Roles whose name comes from their content, so their text IS what they are called. */
const NAME_FROM_CONTENT = [
  "button",
  "a[href]",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
].join(", ");

export function spokenWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The text a sighted person sees inside `el`. */
export function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const gone of copy.querySelectorAll(".sr-only, [hidden]")) gone.remove();
  return copy.textContent ?? "";
}

/** Whether `inner` appears in `outer` as one unbroken run of words, in order. */
function containsRun(outer: string[], inner: string[]): boolean {
  if (inner.length === 0) return true;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

/** The name set apart from the content, or null when the content names it. */
function setApartName(el: Element): string | null {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = el.ownerDocument;
    return labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ");
  }
  return el.getAttribute("aria-label");
}

export function labelInNameMismatches(root: ParentNode): string[] {
  const found: string[] = [];
  for (const el of root.querySelectorAll(NAME_FROM_CONTENT)) {
    const name = setApartName(el);
    if (name === null) continue;
    const seen = spokenWords(visibleText(el));
    if (seen.length === 0) continue;
    if (!containsRun(spokenWords(name), seen)) {
      found.push(`"${name}" does not contain the visible words "${seen.join(" ")}"`);
    }
  }
  return found;
}
