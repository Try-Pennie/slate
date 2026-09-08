// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkPending } from "@/components/ui/LinkPending";

// #1792: this component had no test at all, which is how it shipped a spinner
// that depended on its parent for spacing and then met a parent that had none.
//
// `useLinkStatus` reports the enclosing Link's navigation state, so it is the one
// thing mocked here: everything else is the real component.

const linkStatus = vi.fn(() => ({ pending: false }));
vi.mock("next/link", () => ({ useLinkStatus: () => linkStatus() }));

describe("LinkPending", () => {
  // #2045: the spinner used to be an ordinary in-flow child, so it took width from
  // its siblings the moment it appeared and every nav item to its right jumped
  // sideways for as long as the page took to commit. Dan: "I don't like that the
  // loader pushes other nav items out of the way."
  //
  // The slot is RESERVED instead: the box is always in the layout and only becomes
  // visible while pending, so nothing moves at the moment of the click. That is the
  // one answer with no clipping risk, which the alternatives have: an absolutely
  // positioned child is clipped by a scrolling ancestor (L566) and the sidebar nav
  // is a horizontal scroller below `lg`, and overlaying the label is not available
  // because the header's label is a bare text node with no element to dim.
  it("holds the spinner's space while the link is idle, so nothing moves later", () => {
    linkStatus.mockReturnValue({ pending: false });
    const { container } = render(<LinkPending marker="spinner" />);
    const slot = container.querySelector("[data-link-pending-slot]");
    expect(slot, "the slot is in the layout before any click").toBeTruthy();
    // Hidden, not absent: `visibility` keeps the box and its width.
    expect(slot!.getAttribute("data-pending")).toBeNull();
    // And it says nothing while there is nothing to say.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reserves exactly the space the spinner will occupy", () => {
    // The same element carries the spinner in both states, so the reserved width
    // and the spinner's width cannot drift apart into a shift nobody sees (L63).
    linkStatus.mockReturnValue({ pending: false });
    const idle = render(<LinkPending marker="spinner" />).container.querySelector("[data-link-pending-slot]")!;
    const idleHtml = idle.innerHTML;
    linkStatus.mockReturnValue({ pending: true });
    const busy = render(<LinkPending marker="spinner" />).container.querySelector("[data-link-pending-slot]")!;
    expect(busy.innerHTML).toBe(idleHtml);
  });

  it("draws both the spinner and the page load bar once the link is pending", () => {
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending marker="spinner" />);
    expect(container.querySelector("[data-spinner]")).toBeTruthy();
    expect(container.querySelector(".pn-loadbar")).toBeTruthy();
    // The slot is the same element that was already there; it is marked visible
    // rather than added, which is what makes the click move nothing.
    expect(container.querySelector("[data-link-pending-slot]")!.getAttribute("data-pending"))
      .toBe("");
  });

  it("announces the wait exactly once, from the load bar and not the graphic", () => {
    // Both would announce the SAME wait, and a reader would hear it twice.
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending marker="spinner" />);

    const status = screen.getByRole("status");
    expect(status.className).toContain("pn-loadbar");

    const spinner = container.querySelector("[data-spinner]")!;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("carries its own horizontal spacing rather than relying on a parent gap", () => {
    // #1792: the sidebar's Link has no gap utility, so a spinner depending on its
    // parent for one sat flush against the label's last letter. Still true, and
    // now it is the RESERVED width as well, which is why it is asserted on the
    // slot that is always present rather than only while pending.
    //
    // Asserted as a CLASS because jsdom does not compute Tailwind, so there is no
    // resolved margin to read here; the rendered result is checked in a browser.
    linkStatus.mockReturnValue({ pending: false });
    const { container } = render(<LinkPending marker="spinner" />);
    // `className` on an SVG element is an SVGAnimatedString, not a string, so the
    // attribute is what has to be read.
    expect(container.querySelector("[data-spinner]")!.getAttribute("class")).toContain("mx-1.5");
  });

  // #2103: the HEADER asked for the spinner to go. The reserved slot is a
  // permanent gap in the layout by design, and in a row of three tabs that gap
  // is the widest thing between them (Dan, 2026-09-08: "we separated these nav
  // items to account for the spinner but I think we should just move them closer
  // together, get rid of the spinner").
  //
  // The load bar STAYS, and that is the whole reason this is a marker rather
  // than a removal: the bar carries the only `role="status"` for the wait, costs
  // no layout width because it is fixed positioned, and dropping it would leave
  // a screen reader with nothing at all while the page fetched.
  //
  // Required rather than defaulted, so `tsc` names every call site. A prop each
  // site must remember to pass is a rule that lives only in a prompt (L621): the
  // site that forgets is indistinguishable from the site that chose.
  describe("marker='bar' (the header)", () => {
    it("reserves no width at all, so the tabs sit at their own spacing", () => {
      linkStatus.mockReturnValue({ pending: false });
      const { container } = render(<LinkPending marker="bar" />);
      expect(container.querySelector("[data-link-pending-slot]")).toBeNull();
      expect(container.querySelector("[data-spinner]")).toBeNull();
    });

    it("draws no spinner even while the navigation is in flight", () => {
      // The idle case above is satisfied by a component that renders nothing
      // ever, so the pending case is what proves the slot is gone rather than
      // merely hidden (L159).
      linkStatus.mockReturnValue({ pending: true });
      const { container } = render(<LinkPending marker="bar" />);
      expect(container.querySelector("[data-link-pending-slot]")).toBeNull();
      expect(container.querySelector("[data-spinner]")).toBeNull();
    });

    it("still shows the load bar and still announces the wait once", () => {
      linkStatus.mockReturnValue({ pending: true });
      const { container } = render(<LinkPending marker="bar" />);
      expect(container.querySelector(".pn-loadbar")).toBeTruthy();
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status").className).toContain("pn-loadbar");
    });

    it("says nothing while the link is idle", () => {
      linkStatus.mockReturnValue({ pending: false });
      render(<LinkPending marker="bar" />);
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("stops moving for a reader who asked for less motion", () => {
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending marker="spinner" />);
    const cls = container.querySelector("[data-spinner]")!.getAttribute("class") ?? "";
    expect(cls).toContain("animate-spin");
    expect(cls).toContain("motion-reduce:animate-none");
  });
});
