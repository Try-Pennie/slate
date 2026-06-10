import type { SVGProps } from "react";

export function CheckBadgeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={20}
      height={20}
      fill="none"
      aria-hidden
      focusable={false}
      {...props}
    >
      <circle cx={10} cy={10} r={9} fill="currentColor" />
      <path
        d="M5.8 10.2l3 3L14.5 7.5"
        fill="none"
        stroke="#F9F6F0"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
