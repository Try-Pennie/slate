import type { SVGProps } from "react";

export function InfoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...props}
    >
      <circle cx={12} cy={12} r={9} />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}
