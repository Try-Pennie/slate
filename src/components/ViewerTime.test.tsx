// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

// The device's zone is the one input this component reads from the world, so the
// test sets it rather than inheriting whatever machine runs the suite (L504).
const zone = vi.hoisted(() => ({ value: "America/Phoenix" }));
vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => zone.value }));

import ViewerTime from "@/components/ViewerTime";

const ISO = "2026-07-03T18:00:00Z";

afterEach(() => {
  cleanup();
  zone.value = "America/Phoenix";
});

describe("ViewerTime (#1916)", () => {
  it("renders the instant in the viewer's zone, labelled", () => {
    render(<ViewerTime iso={ISO} />);
    expect(screen.getByText("Fri, Jul 3, 11:00am MST")).toBeTruthy();
  });

  it("follows the viewer: the same instant reads EDT in New York", () => {
    zone.value = "America/New_York";
    render(<ViewerTime iso={ISO} />);
    expect(screen.getByText("Fri, Jul 3, 2:00pm EDT")).toBeTruthy();
  });

  it("carries the machine readable instant on a time element", () => {
    const { container } = render(<ViewerTime iso={ISO} />);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(ISO);
  });

  it("renders seconds when asked", () => {
    render(<ViewerTime iso="2026-07-03T18:03:41Z" seconds />);
    expect(screen.getByText("Fri, Jul 3, 11:03:41am MST")).toBeTruthy();
  });

  it("on the server, which has no viewer, renders UTC and says so", () => {
    // The server snapshot is what hydration compares against, so the first client
    // render matches it and the viewer's zone replaces it right after.
    const html = renderToString(<ViewerTime iso={ISO} />);
    expect(html).toContain("Fri, Jul 3, 6:00pm UTC");
    expect(html).not.toContain("MST");
  });

  it("says an unreadable time is unreadable rather than inventing one", () => {
    render(<ViewerTime iso="not a time" />);
    expect(screen.getByText("time unreadable")).toBeTruthy();
  });
});
