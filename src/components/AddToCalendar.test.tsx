// @vitest-environment jsdom
//
// The add to calendar group (#2165): ONE component, drawn on the Booker's
// confirmation and on the manage page. What is pinned here is the component's
// own contract; where each screen draws it, and when it withholds it, is pinned in
// add-to-calendar-sites.test.tsx.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import AddToCalendar from "@/components/AddToCalendar";
import { ADD_TO_CALENDAR_COPY } from "@/lib/booking/booker-copy";

const links = {
  google: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=x",
  outlook: "https://outlook.live.com/calendar/0/action/compose?x=1",
  office365: "https://outlook.office.com/calendar/0/action/compose?x=1",
  ics: "https://slate.example/api/bookings/tok1/ics",
};

describe("AddToCalendar (#2165)", () => {
  it("offers all four, each to the link the shared builder made", () => {
    render(<AddToCalendar links={links} />);
    const group = screen.getByRole("group", { name: ADD_TO_CALENDAR_COPY.heading });
    const anchors = within(group).getAllByRole("link");
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      links.google,
      links.outlook,
      links.office365,
      links.ics,
    ]);
    for (const label of [
      ADD_TO_CALENDAR_COPY.google,
      ADD_TO_CALENDAR_COPY.outlook,
      ADD_TO_CALENDAR_COPY.office365,
      ADD_TO_CALENDAR_COPY.ics,
    ]) {
      expect(within(group).getByRole("link", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
  });

  it("opens the three web calendars in a new tab and says so, and leaves the file in place", () => {
    render(<AddToCalendar links={links} />);
    for (const label of [
      ADD_TO_CALENDAR_COPY.google,
      ADD_TO_CALENDAR_COPY.outlook,
      ADD_TO_CALENDAR_COPY.office365,
    ]) {
      const a = screen.getByRole("link", { name: new RegExp(`^${label}`) });
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      // A new tab nobody was told about reads as the page going nowhere.
      expect(a.textContent).toContain(ADD_TO_CALENDAR_COPY.newTab);
    }
    // The file is a download the server names, so there is no page to open.
    const ics = screen.getByRole("link", { name: new RegExp(`^${ADD_TO_CALENDAR_COPY.ics}`) });
    expect(ics.getAttribute("target")).toBeNull();
    expect(ics.textContent).not.toContain(ADD_TO_CALENDAR_COPY.newTab);
  });

  it("draws each as a design system control with a 44px target", () => {
    render(<AddToCalendar links={links} />);
    for (const a of screen.getAllByRole("link")) {
      expect(a.className).toContain("pn-btn");
      expect(a.className).toContain("min-h-[44px]");
    }
  });
});
