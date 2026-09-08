"use client";

import type { ReactNode } from "react";

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
  /**
   * What sits after the label, when anything does: today a count pill.
   *
   * A NODE rather than a number (#1847). The pending approvals count is a
   * database read, and it was the last serial hop in front of every internal
   * page: the tab could not render until the number existed. As a node the tab
   * renders immediately and the count arrives under its own `Suspense`
   * boundary, so nothing waits on a nudge.
   *
   * `HeaderNav` no longer knows what a badge looks like; `PendingBadge` does.
   */
  badge?: ReactNode;
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
    // #2103: the tabs sit at their own spacing now that no spinner slot is
    // reserved between them. That slot held about 26px of permanent width per
    // tab whether or not anything was loading, which in a row of three was the
    // widest thing on the bar.
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
            {tab.badge}
            <LinkPending marker="bar" />
          </Link>
        );
      })}
    </nav>
  );
}
