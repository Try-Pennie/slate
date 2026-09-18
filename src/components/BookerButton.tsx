"use client";

import type { ButtonHTMLAttributes } from "react";

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
 */
export interface BookerButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The booker's palette for the theme it is currently wearing. */
  palette: BookerButtonPalette;
  variant: BookerButtonVariant;
  size?: BookerButtonSize;
}

export function BookerButton({
  palette,
  variant,
  size,
  className,
  children,
  ...rest
}: BookerButtonProps) {
  return (
    <button className={bookerButtonClass({ palette, variant, size, className })} {...rest}>
      {children}
    </button>
  );
}
