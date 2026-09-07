"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeAdminHref, type AdminNavGroup } from "@/lib/admin/nav";
import { LinkPending } from "@/components/ui/LinkPending";

/**
 * The admin area's map, always on screen (#1748).
 *
 * `/admin` used to be one flat scroll of about 15 sections and `/admin/settings`
 * a second one of 12, with no way to jump between them and four screens
 * reachable only by going through a card labelled "Alert settings". Every section
 * is its own route now, and this lists all of them with the current one marked,
 * so the whole area is visible at once and anything is one click from anything.
 *
 * The groups are given by the caller already filtered for the person's role
 * (`adminNavFor`), so this renders what it is handed and makes no access decision
 * of its own. It is a client component only to read the current path.
 *
 * `aria-current="page"` carries the highlight to assistive tech, and the marker
 * is a filled left edge plus a weight change, so it is never colour alone.
 */
export function AdminSidebar({ groups }: { groups: AdminNavGroup[] }) {
  const pathname = usePathname();
  const active = activeAdminHref(pathname ?? "");

  if (groups.length === 0) return null;

  return (
    <nav
      aria-label="Admin sections"
      className="shrink-0 border-border py-8 lg:sticky lg:top-16 lg:h-[calc(100dvh-4rem)] lg:w-56 lg:overflow-y-auto lg:border-r lg:pr-6"
    >
      {/* Horizontal and scrollable below lg, where a 224px column would take most
          of the width. The groups stay as headings either way, so the map reads
          the same on a phone as on a desktop. */}
      <ul className="flex gap-6 overflow-x-auto lg:block lg:gap-0 lg:overflow-visible">
        {groups.map((group, i) => (
          // Keyed on the first route rather than the title, since a group that
          // collapses to one item for this role carries no title at all (#1790).
          <li
            key={group.items[0]!.href}
            // #1841: a group with NO heading gets a rule beneath it instead.
            //
            // Dan: the landing page floated alone above the first heading and
            // read as stranded. Giving it a heading is the one fix ruled out,
            // because a heading over a single item promises a section that is
            // not there (#1790). So the rule marks it as its own zone without
            // claiming to be a section.
            //
            // Only the FIRST group can be headingless now (#2043): the demotion
            // that used to strip a heading from any group collapsing to one item
            // is gone, because in the middle of the list it left this rule
            // answering a gap that is ABOVE the group rather than below it. The
            // static list is the only source of a null title and `nav.test.ts`
            // holds it to the first position.
            //
            // The condition stays written for any headingless group rather than
            // for index 0, since that is the property the rule actually depends
            // on and this component renders whatever list it is handed. Never the
            // LAST one, since a trailing rule marks a boundary with nothing on
            // the other side of it.
            //
            // `lg:` only, because below that the groups are laid out as a
            // horizontal scroller and a bottom border would underline one column
            // of a row rather than divide the list.
            className={`min-w-max lg:mb-6 lg:min-w-0 lg:last:mb-0 ${
              group.title === null && i < groups.length - 1
                ? "lg:border-b lg:border-border lg:pb-6"
                : ""
            }`}
          >
            {group.title === null ? null : (
              <h2 className="pn-eyebrow mb-2 text-fg-muted">{group.title}</h2>
            )}
            <ul className="flex gap-1 lg:block lg:space-y-0.5">
              {group.items.map((item) => {
                const current = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? "page" : undefined}
                      // `pn-nav-item` is what moves the focus ring INSIDE this
                      // item (#1768). Its current state is already carried by a
                      // sky wash and a filled left edge, so a ring sitting two
                      // pixels outside the box made three markers on one element
                      // and read as a separate floating object rather than as a
                      // highlight of the thing.
                      className={`pn-nav-item flex min-h-11 items-center rounded-sm border-l-2 px-3 text-sm transition-colors ${
                        current
                          ? "border-accent bg-pennie-sky-soft font-semibold text-fg dark:bg-accent/15"
                          : "border-transparent font-normal text-fg-muted hover:bg-[var(--bg-alt)] hover:text-fg"
                      }`}
                    >
                      {item.label}
                      <LinkPending />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
