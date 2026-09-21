import type { SVGProps } from "react";

/**
 * A handset drawn as a stroke, the booker's marker for the number a lead gave.
 * Not `PhoneIcon`, which is the filled handset the admin surfaces use; the two
 * glyphs differ and the booker's stroke set stays consistent with its clock and
 * globe.
 */
export function PhoneOutlineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
      focusable={false}
      {...props}
    >
      <path
        d="M5 4h3l2 5-2 1a12 12 0 005 5l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
