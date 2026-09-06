/**
 * Scan for a submit button that gives no sign it started (#1769).
 *
 * Dan, on an agent's page: "I clicked make bookable and it worked but it didn't
 * immediately look like it did anything so it felt like I clicked it and it didn't
 * do anything." Both halves of that are defects, and this covers the first: a
 * plain `<button>` inside a server action form has NO pending state at all, so
 * between the press and the response nothing on screen has changed. The worst one
 * was the worst possible: `setBookable` makes a live Google calendar call before
 * it writes anything, so the slowest action in the app was the one with no
 * feedback.
 *
 * `SubmitButton` is the one control, and it carries the three states the standing
 * rule requires: it started, it is still alive, and it has stalled.
 *
 * TWO rules, because a submit can be written in two places:
 *
 *  - an explicit `type="submit"` on a raw `<button>`, ANYWHERE. It only means
 *    anything inside a form, and it is how a submit written in a different file
 *    from its form looks (the pool exit confirm, the request row's cancel).
 *  - a raw `<button>` with no `type` at all inside a `<form action={...}>`, which
 *    is a submit by default and is the shape all six on the agent page had.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads this as broader coverage than it has:
 * a `<button>` with no `type` that is rendered by a component called from inside a
 * form, in a file with no `<form>` in it. Rule one catches that only if the author
 * wrote `type="submit"`. A GET form (`method="GET"`, or a string `action="/path"`)
 * is a navigation rather than an action, `useFormStatus` reports nothing for it,
 * and it is deliberately out of scope.
 */

export interface SubmitSite {
  file: string;
  line: number;
  why: string;
}

// Either comment style, because JSX markup carries `{/* ... */}` rather than `//`.
// The reason must not be the comment's own terminator, or `{/* submit-feedback-ok: */}`
// reads as a reason and the convention decays into a magic word.
const OPT_OUT = /(?:\/\/|\{?\/\*)\s*submit-feedback-ok:\s*(?!\*\/)\S/;

/**
 * A form opening tag whose action is a FUNCTION, not a URL.
 *
 * `<SaveForm>` counts: it renders a real `<form>` and takes a server action
 * (#1994). Reading only `<form` stopped seeing the agent page the moment its
 * forms moved onto the wrapper, and this file's own control is what said so: the
 * plain button it plants was no longer inside anything the scanner recognised as
 * a form, so it reported a clean file. A check that stops MATCHING and a
 * converted tree produce the same empty list (L98).
 */
const ACTION_FORM = /<(?:form|SaveForm)\b[^>]*\saction=\{/;
/** Any form opening tag, so a GET form still closes a region. */
const FORM_OPEN = /<(?:form|SaveForm)\b/;
const FORM_CLOSE = /<\/(?:form|SaveForm)>/;

function optedOut(lines: string[], i: number): boolean {
  if (OPT_OUT.test(lines[i])) return true;
  for (let up = i - 1; up >= 0; up--) {
    const above = lines[up].trim();
    if (!above.startsWith("//") && !above.startsWith("*") && !above.startsWith("{/*")) break;
    if (OPT_OUT.test(above)) return true;
  }
  return false;
}

/**
 * The `<button` openings in `text` that are submits with no feedback.
 *
 * Line based on purpose: a JSX element's attributes are usually spread over
 * several lines, so a button's opening tag is followed until its `>`.
 */
export function scanSubmitFeedback(file: string, text: string): SubmitSite[] {
  const lines = text.split("\n");
  const out: SubmitSite[] = [];

  /** How many action-form regions we are inside. */
  let inActionForm = 0;
  /** How many plain (GET, or string action) form regions we are inside. */
  let inPlainForm = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FORM_OPEN.test(line)) {
      if (ACTION_FORM.test(line)) inActionForm++;
      else inPlainForm++;
    }
    if (FORM_CLOSE.test(line)) {
      if (inActionForm > 0) inActionForm--;
      else if (inPlainForm > 0) inPlainForm--;
    }

    if (!/<button\b/.test(line)) continue;

    // The whole opening tag, which may run over several lines.
    let tag = line.slice(line.indexOf("<button"));
    for (let j = i + 1; j < lines.length && !tag.includes(">"); j++) tag += `\n${lines[j]}`;
    const attrs = tag.slice(0, tag.indexOf(">") + 1);

    const explicitSubmit = /type=\{?["']submit["']\}?/.test(attrs);
    const hasType = /\stype=/.test(attrs);

    if (optedOut(lines, i)) continue;

    // An explicit submit inside a GET or string-action form is a navigation, and
    // `useFormStatus` reports nothing for one, so there is no pending state to
    // show. Judged here rather than by rule one alone, which cannot see the form.
    if (explicitSubmit && inPlainForm > 0 && inActionForm === 0) continue;

    if (explicitSubmit) {
      out.push({
        file,
        line: i + 1,
        why: 'a raw <button type="submit"> shows nothing while the action runs; use SubmitButton',
      });
      continue;
    }
    if (!hasType && inActionForm > 0) {
      out.push({
        file,
        line: i + 1,
        why: "a <button> with no type inside a server action form is a submit that shows nothing while it runs; use SubmitButton",
      });
    }
  }

  return out;
}
