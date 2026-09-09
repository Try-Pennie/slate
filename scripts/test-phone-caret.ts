// #2162: the phone field reformats itself on every keystroke, so the caret has to
// be put back deliberately. Left alone, a controlled input whose value is rewritten
// lands the caret at the END, and a lead correcting one digit in the middle of a
// number they have already typed cannot do it: the digit they type appears at the
// end instead.
//
// The caret is restored by counting DIGITS, never by the raw character offset. The
// formatter adds and removes brackets, a space and a hyphen as the number grows, so
// a character count drifts by one every time a separator appears or disappears, and
// it drifts in a way that only shows up at particular lengths.
//
// Every case here is a position a lead actually reaches. Typing at the end, the one
// position every previous test used, is the single position where the defect cannot
// occur.
// Run: node --experimental-strip-types scripts/test-phone-caret.ts
import { assert, finish } from "./lib/harness.ts";
import { caretAfterFormat, formatPhoneAsTyped } from "../src/lib/phone-format.ts";

/** What the field does to one keystroke: the raw value the browser produced and
 *  where its caret was, in; the value that gets rendered and where the caret is
 *  put back, out. */
function keystroke(raw: string, rawCaret: number) {
  const formatted = formatPhoneAsTyped(raw);
  return { formatted, caret: caretAfterFormat(raw, rawCaret, formatted) };
}

/** The rendered value with a bar where the caret sits, which is what the lead
 *  actually sees and the only readable way to assert this. */
function shown({ formatted, caret }: { formatted: string; caret: number }): string {
  return `${formatted.slice(0, caret)}|${formatted.slice(caret)}`;
}

// 1. Typing a digit in the middle. Dan's report: caret between the 6 and the 7 of
//    "(555) 567-8987", type a digit, and it must land THERE.
{
  // The browser has already inserted the "1" at index 8 and moved the caret to 9.
  const r = keystroke("(555) 5617-8987", 9);
  assert(r.formatted === "(555) 561-7898", `reformats to the capped number, got ${r.formatted}`);
  assert(shown(r) === "(555) 561|-7898", `caret sits after the typed digit, got ${shown(r)}`);
}

// 2. Backspace in the middle leaves the caret where the deletion happened.
{
  const r = keystroke("(555) 56-8987", 8);
  assert(r.formatted === "(555) 568-987", `reformats, got ${r.formatted}`);
  assert(shown(r) === "(555) 56|8-987", `caret stays at the deletion, got ${shown(r)}`);
}

// 3. Typing immediately before a separator does not jump over it or land behind it.
//    "(555) 567" with the caret after the ")" is followed by a space the lead never
//    typed, so the digit must appear after that space, not before it.
{
  const r = keystroke("(555)8 567", 6);
  assert(r.formatted === "(555) 856-7", `reformats, got ${r.formatted}`);
  assert(shown(r) === "(555) 8|56-7", `caret follows the digit past the space, got ${shown(r)}`);
}

// 4. Typing over a selection. The browser has already replaced the range, so the
//    only thing that matters is that the caret follows the replacement.
{
  // "(555) 567-8987" with "567" selected and "1" typed in its place.
  const r = keystroke("(555) 1-8987", 7);
  assert(shown(r) === "(555) 1|89-87", `caret follows the replacement, got ${shown(r)}`);
}

// 5. A paste of a whole number leaves the caret at the end, where a person expects
//    to carry on typing from.
{
  const r = keystroke("2035615295", 10);
  assert(r.formatted === "(203) 561-5295", `formats the paste, got ${r.formatted}`);
  assert(r.caret === r.formatted.length, `caret at the end, got ${r.caret}`);
}

// 6. A paste carrying a country code loses a digit to the strip, and the caret must
//    not run off the end of the shorter value it produced.
{
  const r = keystroke("+1 203 561 5295", 15);
  assert(r.formatted === "(203) 561-5295", `strips the country code, got ${r.formatted}`);
  assert(r.caret === r.formatted.length, `caret clamped to the value, got ${r.caret}`);
}

// 7. Typing past the cap changes nothing, so the caret must not advance either.
//    Left unclamped it would sit one past the last character every keystroke.
{
  const r = keystroke("(203) 561-52955", 15);
  assert(r.formatted === "(203) 561-5295", `holds at ten digits, got ${r.formatted}`);
  assert(r.caret === r.formatted.length, `caret still inside the value, got ${r.caret}`);
}

// 8. An empty field, and a caret before the opening bracket the lead never typed.
{
  assert(caretAfterFormat("", 0, "") === 0, "an empty value puts the caret at 0");
  // Nothing typed yet sits before the first digit, never outside the bracket.
  assert(caretAfterFormat("(555", 0, "(555") === 1, "caret goes to the first digit, not before the bracket");
}

// 9. The caret is never outside the value it is being put into, whatever it is
//    handed. A caret past the end throws on setSelectionRange in some browsers and
//    silently misplaces in others, so it is clamped here rather than at each site.
{
  for (const [raw, caret] of [["(555) 567", 99], ["(555) 567", -3], ["", 5]] as const) {
    const f = formatPhoneAsTyped(raw);
    const c = caretAfterFormat(raw, caret, f);
    assert(c >= 0 && c <= f.length, `caret ${c} is inside "${f}" for raw "${raw}" at ${caret}`);
  }
}

finish();
