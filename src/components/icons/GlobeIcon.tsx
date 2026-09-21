import type { SVGProps } from "react";

/** A globe with one meridian pair: the booker's marker for a timezone. */
export function GlobeIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </svg>
  );
}
