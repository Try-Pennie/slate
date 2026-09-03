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
  it("draws nothing at all while the link is idle", () => {
    linkStatus.mockReturnValue({ pending: false });
    const { container } = render(<LinkPending />);
    expect(container.innerHTML).toBe("");
  });

  it("draws both the spinner and the page load bar once the link is pending", () => {
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending />);
    expect(container.querySelector("[data-spinner]")).toBeTruthy();
    expect(container.querySelector(".pn-loadbar")).toBeTruthy();
  });

  it("announces the wait exactly once, from the load bar and not the graphic", () => {
    // Both would announce the SAME wait, and a reader would hear it twice.
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending />);

    const status = screen.getByRole("status");
    expect(status.className).toContain("pn-loadbar");

    const spinner = container.querySelector("[data-spinner]")!;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("carries its own horizontal spacing rather than relying on a parent gap", () => {
    // This is the defect: the sidebar's Link has no gap utility, so a spinner
    // depending on its parent for one sat flush against the label's last letter.
    // Asserted as a CLASS because jsdom does not compute Tailwind, so there is no
    // resolved margin to read here; the class is the only evidence available in
    // this harness, and the rendered result is checked in a browser instead.
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending />);
    // `className` on an SVG element is an SVGAnimatedString, not a string, so the
    // attribute is what has to be read.
    expect(container.querySelector("[data-spinner]")!.getAttribute("class")).toContain("mx-1.5");
  });

  it("stops moving for a reader who asked for less motion", () => {
    linkStatus.mockReturnValue({ pending: true });
    const { container } = render(<LinkPending />);
    const cls = container.querySelector("[data-spinner]")!.getAttribute("class") ?? "";
    expect(cls).toContain("animate-spin");
    expect(cls).toContain("motion-reduce:animate-none");
  });
});
