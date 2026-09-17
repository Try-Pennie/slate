// A raw `<form>` that can hold typed work and does not guard it (#2076).
//
// The OTHER half of this is ownership, not a scan: `SaveForm` mounts the guard
// itself and takes a required `unsaved` prop, so `tsc` enumerates every call site
// and omission is impossible. A behaviour each site must opt into cannot be
// enforced by a scan at all, because a site that never opts in is
// indistinguishable from one where the condition never arises (L621).
//
// What a scan CAN answer is the half that asks about STRUCTURE rather than about
// opt in: a `<form>` written by hand next month, holding a control somebody types
// into, with nothing guarding it. That is exactly the shape of the existing
// convention guards (`scan-capped-reads`, `scan-swallowed-error-reads`), with the
// same one line escape hatch.
//
// PURE, so `scripts/test-unsaved-guard-coverage.ts` can drive it over fixtures as
// well as over the real tree.

/** A control a person types or chooses a value in. */
import { hasOptOut } from "./opt-out.ts";

const EDITABLE = /<(textarea|select)\b|<input\b(?![^>]*\btype=(?:"|')(?:hidden|submit|button|image|reset)(?:"|'))/;

/**
 * The one line opt out, which must carry a reason.
 *
 * Matched in ANY comment form, because the place it has to be written is between
 * JSX elements, where `//` is not a comment at all: the real ones are `{/* ... *\/}`
 * blocks, and a convention that only read `//` would be one nobody could obey where
 * it is needed.
 */
export interface UnguardedForm {
  file: string;
  line: number;
}

/**
 * Every hand written form in this source that could lose typed work.
 *
 * A form is compliant when it mounts `UnsavedGuard` inside itself, or carries the
 * `// unsaved-ok:` opt out on the `<form` line or in the comment block directly
 * above it. `SaveForm` is not looked for here: it is a component, its own guard is
 * unconditional, and a file using it has no raw `<form>` to find.
 */
export function scanUnsavedGuard(file: string, source: string): UnguardedForm[] {
  const lines = source.split("\n");
  const out: UnguardedForm[] = [];
  for (let i = 0; i < lines.length; i++) {
    // `\b` rather than a following space or `>`, because a multi line JSX form
    // opens with `<form` and NOTHING else on the line, which is how three of the
    // real ones were missed by the first version of this (L1).
    if (!/<form\b/.test(lines[i]!)) continue;
    // The block this form encloses. One form per file in this tree, and a nested
    // one is impossible in HTML, so the next `</form>` is this form's end.
    const close = lines.findIndex((l, j) => j > i && l.includes("</form>"));
    const block = lines.slice(i, close === -1 ? lines.length : close + 1).join("\n");
    if (!EDITABLE.test(block)) continue;
    if (block.includes("<UnsavedGuard")) continue;
    if (optedOut(lines, i)) continue;
    out.push({ file, line: i + 1 });
  }
  return out;
}

/**
 * The opt out on the line itself, or in the comment block directly above it.
 *
 * The block is read WHOLE rather than line by line, because the reason is a
 * sentence and a sentence wraps: in every real case here the `unsaved-ok:` is on
 * the block's FIRST line and the line directly above the form is the block's last,
 * which reads as ordinary prose. A per line test found none of them.
 */
function optedOut(lines: string[], at: number): boolean {
  return hasOptOut(lines, at, "unsaved-ok:");
}
