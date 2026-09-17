"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";
import { activeAdminHref, activeAdminItem, type AdminNavGroup } from "@/lib/admin/nav";
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
 * of its own. It is a client component to read the current path and to hold the
 * open state of the small width control below.
 *
 * `aria-current="page"` carries the highlight to assistive tech, and the marker
 * is a filled left edge plus a weight change, so it is never colour alone.
 *
 * ONE LIST, TWO PRESENTATIONS (#2506). From `lg` up it is the column it has
 * always been. Below that it is a disclosure: a control naming the section you
 * are in, and the same list beneath it. What it is NOT any more is the column
 * with its `lg:` classes switched off, which is what shipped: the groups were
 * laid out as a horizontal `overflow-x-auto` row, so the headings sat on one
 * baseline and the links on another, the overview floated above its own row, and
 * every group past Routing sat off the right edge with nothing saying the row
 * continued (L76). Most of the admin area was reachable only by guessing that it
 * scrolled.
 *
 * The list itself is rendered once and shown or hidden by class, rather than
 * drawn twice for the two widths: a second copy would put every link, heading
 * and `aria-current` in the document twice, and the two copies would drift.
 */
export function AdminSidebar({ groups }: { groups: AdminNavGroup[] }) {
  const pathname = usePathname() ?? "";
  const active = activeAdminHref(pathname);
  const current = activeAdminItem(groups, pathname);
  /**
   * WHICH PAGE the list was opened from, rather than a bare open flag, so that
   * arriving somewhere new shuts it with nothing having to notice.
   *
   * It shuts on ARRIVAL and never on the press: each entry carries an in flight
   * marker, so closing in the click handler would unmount the link that was just
   * pressed and take its only feedback away for the whole navigation. Holding
   * the path it was opened for makes that a derivation rather than a second copy
   * of the truth kept in step by an effect.
   */
  const [openedFrom, setOpenedFrom] = useState<string | null>(null);
  const open = openedFrom === pathname;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  if (groups.length === 0) return null;

  return (
    <nav
      aria-label="Admin sections"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        setOpenedFrom(null);
        // Back to the control, or a keyboard reader is left standing on a link
        // that has just been taken off the screen.
        triggerRef.current?.focus();
      }}
      className="shrink-0 border-border pt-4 pb-0 lg:sticky lg:top-16 lg:h-[calc(100dvh-4rem)] lg:w-56 lg:overflow-y-auto lg:border-r lg:py-8 lg:pr-6"
    >
      {/* Below `lg` the one thing always on screen is where you ARE, so the map
          costs a line rather than a third of the page and the reader still never
          has to ask which section they are in. */}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpenedFrom(open ? null : pathname)}
        className="pn-btn pn-btn--additional flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 text-sm lg:hidden"
      >
        <span className="min-w-0 truncate">
          {current === null ? (
            // No nearest guess. A control confidently naming the wrong section
            // tells you where you are and is lying, which is worse than saying
            // nothing, so an unclaimed path gets the plain name of the list.
            "Admin sections"
          ) : (
            <>
              <span className="sr-only">Admin section: </span>
              {current.label}
            </>
          )}
        </span>
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      <ul
        id={listId}
        // `hidden` closes it below `lg` only: `lg:block` puts the column back
        // whatever the control was left at, so widening a window can never empty
        // the sidebar. Below `lg` the open list is a surface of its own, because
        // an opened panel that shares the page background reads as the page
        // having grown rather than as something that can be shut again.
        //
        // Two columns from `sm` up, because one column of seventeen entries runs
        // to about a thousand pixels and pushes the page the reader came for off
        // the bottom, which is the complaint this is answering. Each group is
        // kept whole across the break, so a heading can never end a column with
        // its own entries starting the next one.
        className={`${open ? "" : "hidden "}mt-3 rounded-xl border border-border bg-surface p-3 shadow-xs sm:columns-2 sm:gap-x-6 lg:mt-0 lg:block lg:columns-1 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none`}
      >
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
            // It is no longer `lg:` only (#2506). The rule was held back because
            // below that width the groups were a horizontal row, where a bottom
            // border underlines one column rather than dividing the list. Both
            // widths run vertically now, so the mark belongs at both.
            className={`mb-6 break-inside-avoid last:mb-0 ${
              group.title === null && i < groups.length - 1
                ? "border-b border-border pb-6"
                : ""
            }`}
          >
            {group.title === null ? null : (
              <h2 className="pn-eyebrow mb-2 text-fg-muted">{group.title}</h2>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isCurrent = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isCurrent ? "page" : undefined}
                      // `pn-nav-item` is what moves the focus ring INSIDE this
                      // item (#1768). Its current state is already carried by a
                      // sky wash and a filled left edge, so a ring sitting two
                      // pixels outside the box made three markers on one element
                      // and read as a separate floating object rather than as a
                      // highlight of the thing.
                      className={`pn-nav-item flex min-h-11 items-center rounded-sm border-l-2 px-3 text-sm transition-colors ${
                        isCurrent
                          ? "border-accent bg-pennie-sky-soft font-semibold text-fg dark:bg-accent/15"
                          : "border-transparent font-normal text-fg-muted hover:bg-[var(--bg-alt)] hover:text-fg"
                      }`}
                    >
                      {item.label}
                      <LinkPending marker="spinner" />
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
