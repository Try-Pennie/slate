import type { SVGProps } from "react";

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
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
      <path
        d="M 13 11 L 22 11 L 22 13 L 13 13 L 13 22 L 11 22 L 11 13 L 2 13 L 2 11 L 11 11 L 11 2 L 13 2 L 13 11 Z"
        fillRule="evenodd"
      />
    </svg>
  );
}
