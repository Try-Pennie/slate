"use client";

import type { ReactNode } from "react";

/**
 * A <select> that submits its enclosing GET form as soon as the value changes,
 * so table filters apply instantly without a separate "Apply" click. Degrades
 * gracefully: with JS off it's a plain select and the form's submit button
 * still works.
 */
export function AutoSubmitSelect({
  name,
  defaultValue,
  ariaLabel,
  className,
  children,
}: {
  name: string;
  defaultValue: string;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      className={className}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    >
      {children}
    </select>
  );
}
