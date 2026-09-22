import type { SVGProps } from "react";

/**
 * The Pennie logo mark (#2629), from the design system's `assets/logo-mark.svg`
 * and identical to the app icon (`src/app/icon.svg`), which a test holds it to.
 *
 * Drawn inline in `currentColor` rather than as an `<img>`: the design system
 * mark is authored that way, and it lets ONE element follow whichever theme the
 * booker, or the page embedding it, has set. The wordmarks elsewhere carry fixed
 * fills and so need a light and a dark file; this does not.
 *
 * Decorative by default, like the other icons. Pass `label` to name it, and only
 * when there is a real name to give: an image called "" is worse than none (L577).
 */
export function PennieMark({ label, ...props }: SVGProps<SVGSVGElement> & { label?: string }) {
  const named = Boolean(label);
  return (
    <svg
      viewBox="0 0 20.091 22.331"
      width={20}
      height={22}
      fill="none"
      focusable={false}
      {...(named ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    >
      <path
        d="M 11.481 0 C 11.481 0 11.474 0 11.47 0 C 9.965 0 8.476 0.298 7.087 0.873 C 5.694 1.45 4.428 2.296 3.363 3.363 C 2.297 4.428 1.452 5.694 0.873 7.087 C 0.296 8.48 0 9.973 0 11.481 C 0 12.99 0.296 14.481 0.873 15.874 C 1.45 17.267 2.296 18.533 3.363 19.598 C 4.428 20.663 5.694 21.509 7.087 22.088 C 7.299 22.176 7.512 22.257 7.728 22.331 L 7.728 16.363 L 7.728 8.611 C 7.728 6.539 9.408 4.86 11.48 4.86 C 13.551 4.86 15.231 6.539 15.231 8.611 C 15.231 10.683 13.551 12.362 11.48 12.362 C 11.04 12.362 10.62 12.288 10.228 12.149 L 10.228 17.128 C 10.636 17.187 11.054 17.222 11.48 17.222 C 16.235 17.222 20.091 13.367 20.091 8.611 C 20.091 3.855 16.237 0 11.481 0 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
