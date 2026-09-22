"use client";

import type { ButtonHTMLAttributes } from "react";

import { BobbingDots } from "@/components/BobbingDots";
import {
  bookerButtonClass,
  type BookerButtonPalette,
  type BookerButtonSize,
  type BookerButtonVariant,
} from "@/components/booker-button";

/**
 * A button on the booker (#2562).
 *
 * The geometry, the label weight and the disabled treatment live in
 * `bookerButtonClass`; this is the element. Everything else a `<button>` takes is
 * passed straight through, INCLUDING `type`: several converted sites sit inside
 * the phone form and several outside any form, so a default here would quietly
 * change what a press does rather than only how it looks.
 *
 * `className` is for the call site's own LAYOUT (a margin, a width, the `group`
 * marker the confirm button's arrow animates off). Colour and size belong to the
 * variant and the size, or the next hand written copy starts here.
 *
 * **`busy` is the working cue, and it lives here so a call site cannot omit it**
 * (#2604, L621). Every lead facing action that does not return instantly has to
 * keep three states visibly apart: started, still alive, and failed. A label swap
 * on its own is one picture that never changes again, so a request in flight and
 * one that died look identical, which is what Dan met confirming a booking on
 * 2026-09-22: "the loading felt stuck after I submitted my time. it wasn't stuck,
 * it worked, but it didn't feel like it was moving." The middle state, the "still
 * working" line after ten seconds, stays where it is at the call site: it is a
 * sentence, not a treatment.
 */
export interface BookerButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The booker's palette for the theme it is currently wearing. */
  palette: BookerButtonPalette;
  variant: BookerButtonVariant;
  size?: BookerButtonSize;
  /**
   * The work this button started is still running. Draws the moving cue beside
   * the label. The caller still swaps the LABEL, because what is happening is
   * different for each one ("Booking your call…", "Cancelling…", "Moving your
   * call…") and only the caller knows which.
   */
  busy?: boolean;
}

export function BookerButton({
  palette,
  variant,
  size,
  busy,
  className,
  children,
  ...rest
}: BookerButtonProps) {
  return (
    <button className={bookerButtonClass({ palette, variant, size, className })} {...rest}>
      {/* Before the label, so the cue is in the same place on every button
          whatever its words, and so a label that wraps cannot push it out of
          sight. Hidden from assistive tech: the label already says what is
          happening, and a second announcement of the same fact is noise. */}
      {busy && <BobbingDots tone="current" />}
      {children}
    </button>
  );
}
