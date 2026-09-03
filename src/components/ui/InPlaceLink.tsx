"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

/**
 * A list-control link (clear filters, pagination) that navigates client-side
 * with the scroll position preserved, instead of the hard document reload a
 * plain anchor triggers on a `force-dynamic` page (#951/#952). It stays a real
 * `<a href>`, so it degrades gracefully with JS off and honors modifier- and
 * middle-clicks (open in a new tab) rather than hijacking them.
 *
 * Use `replace` for controls that reset state (clear filters) so they don't add
 * a history entry; leave it off for pagination, matching normal anchor history
 * behavior.
 */
export function InPlaceLink({
  href,
  replace = false,
  className,
  role,
  children,
}: {
  href: string;
  replace?: boolean;
  className?: string;
  /** An ARIA role, for a link that is an item in something (a menu, #1794). */
  role?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    (replace ? router.replace : router.push)(href, { scroll: false });
  }

  return (
    <a href={href} role={role} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
