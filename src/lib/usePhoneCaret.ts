"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { caretAfterFormat, formatPhoneAsTyped } from "@/lib/phone-format";

/**
 * A phone input that reformats as the lead types WITHOUT throwing their cursor to
 * the end (#2162).
 *
 * Dan, 2026-09-09: put the cursor between two digits of a number already typed and
 * type, and the digit appears at the end instead. That is what a controlled input
 * does when its value is rewritten: React sets `value`, the browser has no reason
 * to keep a caret in a string it did not have before, and it goes to the end.
 * Correcting one digit in the middle is then impossible without deleting
 * everything after it.
 *
 * Restoring it has to happen in a LAYOUT effect, after React has written the new
 * value to the DOM node and before the browser paints. Doing it in the change
 * handler is too early (the node still holds the old value), and doing it in a
 * plain effect is late enough to be seen as a jump.
 *
 * Both surfaces that take a phone number use this, so they cannot diverge: the
 * booker and the manage page share `formatPhoneAsTyped`, so before this they
 * shared the defect too.
 */
export function usePhoneCaret(onValue: (formatted: string) => void) {
  const node = useRef<HTMLInputElement | null>(null);
  /** Where to put the caret once the new value is on the node. Null between
   *  keystrokes, so a re-render caused by anything else (an error appearing, a
   *  sibling field) never moves a caret the lead placed themselves. */
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = node.current;
    const at = pending.current;
    pending.current = null;
    if (input == null || at == null) return;
    // Only while the field has focus. Restoring a selection on a blurred input
    // focuses it in some browsers, which would steal focus from wherever the lead
    // actually is.
    if (document.activeElement !== input) return;
    input.setSelectionRange(at, at);
  });

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const rawCaret = e.target.selectionStart ?? raw.length;
    const formatted = formatPhoneAsTyped(raw);
    pending.current = caretAfterFormat(raw, rawCaret, formatted);
    onValue(formatted);
  }

  /**
   * A CALLBACK ref rather than a ref object. Handing a caller `{ ref }` to spread
   * makes every render read a property named `ref` off an object, which the React
   * hooks lint reads as touching a ref during render and refuses. A callback is
   * also the more honest shape: the hook owns the node and the caller only
   * attaches it.
   */
  const attach = useCallback((input: HTMLInputElement | null) => {
    node.current = input;
  }, []);

  return { attach, onChange };
}
