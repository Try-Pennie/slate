"use client";

import { useId } from "react";
import type { CalendarLinks } from "@/lib/booking/calendar-links";
import { ADD_TO_CALENDAR_COPY } from "@/lib/booking/booker-copy";

/**
 * The four add to calendar buttons for one call (#2165), drawn on the Booker's
 * confirmation and on the manage page. One component so the two screens cannot
 * offer the same thing two ways (L613).
 *
 * It takes the links and builds none: they come from `calendarLinks`
 * (`src/lib/booking/calendar-links.ts`, #2643), the one builder behind the booking
 * lookup, the confirm and reschedule responses and the ICS file. Deciding WHETHER
 * to draw it (a cancelled call, a weak match, links the server could not build) is
 * the caller's, because only the caller knows which booking it is looking at.
 *
 * The three web calendars open a new tab, so the lead keeps this screen. The ICS
 * link does not: the server answers it as a download, so there is no page to open,
 * and a call cancelled since is sent to its manage page instead (#2648).
 */
export default function AddToCalendar({
  links,
  className = "",
}: {
  links: CalendarLinks;
  className?: string;
}) {
  const headingId = useId();
  const web: { key: "google" | "outlook" | "office365"; href: string }[] = [
    { key: "google", href: links.google },
    { key: "outlook", href: links.outlook },
    { key: "office365", href: links.office365 },
  ];
  // A secondary design system button: this is a helpful extra, never the page's
  // primary action, and sky is reserved for that (80/15/5). The inner span carries
  // the label so nothing relies on the button's own gap, which Safari ignores (L729).
  const button =
    "pn-btn pn-btn--additional min-h-[44px] w-full rounded-lg px-3 text-sm";
  return (
    <div role="group" aria-labelledby={headingId} className={className}>
      <p id={headingId} className="text-sm font-semibold text-fg">
        {ADD_TO_CALENDAR_COPY.heading}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {web.map(({ key, href }) => (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={button}>
            <span>{ADD_TO_CALENDAR_COPY[key]}</span>
            <span className="sr-only"> {ADD_TO_CALENDAR_COPY.newTab}</span>
          </a>
        ))}
        <a href={links.ics} className={button}>
          <span>{ADD_TO_CALENDAR_COPY.ics}</span>
        </a>
      </div>
    </div>
  );
}
