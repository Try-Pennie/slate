"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkPending } from "@/components/ui/LinkPending";

/**
 * The header's top-level tabs, and the one piece of the header that has to know
 * where you are.
 *
 * It reads the path itself rather than taking an `active` prop (#1748). Since the
 * admin console renders its header ONCE, from `src/app/admin/layout.tsx`, there is
 * no longer a page in a position to say which tab it is: the layout wraps
 * `/admin` and `/admin/ooo` alike, and a single hardcoded value there would light
 * the wrong tab on one of them.
 *
 * `/admin/ooo` is matched before `/admin`, because `/admin` is a prefix of it and
 * a plain prefix test lights both.
 */
export interface HeaderTab {
  href: string;
  label: string;
  /** Optional count shown as a sky-soft badge (e.g. pending approvals). */
  badge?: number;
}

/** The tab the current path belongs to: longest match, so a prefix cannot win. */
export function activeTab(pathname: string, tabs: HeaderTab[]): string | null {
  let best: string | null = null;
  for (const t of tabs) {
    const hit = pathname === t.href || pathname.startsWith(t.href + "/");
    if (hit && (best === null || t.href.length > best.length)) best = t.href;
  }
  return best;
}

export function HeaderNav({ tabs }: { tabs: HeaderTab[] }) {
  const pathname = usePathname() ?? "";
  const active = activeTab(pathname, tabs);
  return (
    <nav aria-label="Slate sections" className="flex items-center gap-5">
      {tabs.map((tab) => {
        const current = tab.href === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`flex min-h-11 min-w-11 items-center gap-1.5 ${
              current
                ? "pn-small-bold"
                : "text-sm text-fg-muted transition-colors hover:text-fg"
            }`}
          >
            {tab.label}
            {!!tab.badge && tab.badge > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-pennie-sky-soft px-1.5 text-xs font-semibold tabular-nums text-pennie-blue dark:bg-accent/15 dark:text-pennie-sky"
                >
                  {tab.badge > 99 ? "99+" : tab.badge}
                </span>
                <span className="sr-only">
                  ({tab.badge} {tab.badge === 1 ? "request" : "requests"} pending)
                </span>
              </>
            )}
            <LinkPending />
          </Link>
        );
      })}
    </nav>
  );
}
