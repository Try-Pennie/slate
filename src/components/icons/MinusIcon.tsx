import type { SVGProps } from "react";

export function MinusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="currentColor"
      aria-hidden
      focusable={false}
      {...props}
    >
      <path d="M 2 11 L 22 11 L 22 13 L 2 13 L 2 11 Z" />
    </svg>
  );
}
