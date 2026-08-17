// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LegalFooter from "@/components/LegalFooter";
import { legalLinks, LEGAL_COPY } from "@/lib/booking/booker-copy";

// #1041: the standalone booker and the manage page are the two lead-facing
// surfaces with no trypennie.com page around them, so they inherit none of
// Pennie's policies. This is the only place on any Slate surface that points a
// customer at one.
describe("LegalFooter", () => {
  it("renders every link the copy builder declares, pointing where it says", () => {
    render(<LegalFooter />);

    for (const { label, href } of legalLinks()) {
      const a = screen.getByRole("link", { name: label });
      // Absolute, because this is served from slate.trypennie.app: a relative
      // path would resolve against the wrong host and 404.
      expect(a.getAttribute("href")).toBe(href);
    }
  });

  it("names the group for assistive tech rather than leaving two bare links", () => {
    render(<LegalFooter />);
    expect(screen.getByRole("contentinfo", { name: LEGAL_COPY.heading })).toBeTruthy();
  });

  it("opens the policy in a new tab without handing it window.opener", () => {
    render(<LegalFooter />);
    const a = screen.getByRole("link", { name: legalLinks()[0]!.label });
    expect(a.getAttribute("target")).toBe("_blank");
    // A lead mid booking must not lose the page, and a new tab that can reach
    // back through window.opener is a tabnabbing hole.
    expect(a.getAttribute("rel")).toMatch(/noopener/);
    expect(a.getAttribute("rel")).toMatch(/noreferrer/);
  });

  it("takes its words from the builder, never its own copy", () => {
    // The parity rule the rest of the lead-facing copy lives under: a component
    // holding its own sentence renders happily while `pnpm preview:booker` shows
    // text that no longer ships, which is worse than no preview.
    render(<LegalFooter />);
    const footer = screen.getByRole("contentinfo");
    for (const { label } of legalLinks()) {
      expect(footer.textContent).toContain(label);
    }
  });
});
