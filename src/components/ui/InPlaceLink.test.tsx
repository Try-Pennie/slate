// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { InPlaceLink } from "@/components/ui/InPlaceLink";

// #952: list controls (clear filters, pagination) that were plain anchors did a
// hard reload and jumped the viewport. InPlaceLink navigates client-side with
// scroll preserved, while staying a real <a href> so it degrades gracefully and
// honors modifier-clicks (open in new tab).
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

describe("InPlaceLink (#952)", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
  });

  it("navigates client-side with scroll preserved on a plain click", () => {
    const { getByText } = render(<InPlaceLink href="/admin?page=2">Next</InPlaceLink>);
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    getByText("Next").dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(push).toHaveBeenCalledWith("/admin?page=2", { scroll: false });
  });

  it("uses replace when asked (clear filters, no history entry)", () => {
    const { getByText } = render(
      <InPlaceLink href="/admin" replace>
        clear
      </InPlaceLink>,
    );
    fireEvent.click(getByText("clear"));
    expect(replace).toHaveBeenCalledWith("/admin", { scroll: false });
    expect(push).not.toHaveBeenCalled();
  });

  it("lets the browser handle modifier / non-left clicks (open in new tab)", () => {
    const { getByText } = render(<InPlaceLink href="/admin?page=2">Next</InPlaceLink>);
    const link = getByText("Next");
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { button: 1 });
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders a real anchor with href and className for graceful fallback", () => {
    const { getByText } = render(
      <InPlaceLink href="/admin?page=2" className="btn">
        Next
      </InPlaceLink>,
    );
    const link = getByText("Next") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/admin?page=2");
    expect(link.className).toBe("btn");
  });
});
