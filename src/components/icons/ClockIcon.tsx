import type { SVGProps } from "react";

/** A clock face at ten past two: the booker's marker for a call's length. */
export function ClockIcon(props: SVGProps<SVGSVGElement>) {
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
      <circle cx={12} cy={12} r={9} />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}
