// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import StandaloneTheme from "@/components/StandaloneTheme";

// #706: standalone lead-facing pages render inside the root layout, whose <html>
// carries the product default. Setting data-theme only on an inner content
// element left the document root (html/body) beige, showing as a gutter at the
// scrollbar/overflow edges in dark mode. This component paints the theme at the
// document root so there is no beige gutter.
//
// #2100: these assert what the script DOES, not what it says. They read the
// emitted text for a "dark" / "light" substring, which was a fair proxy while
// the script was a bare assignment and stopped being one when it started
// carrying the shared resolution (which names both themes whatever it resolves
// to). Running it is the stronger check anyway: a script that mentions the right
// word and paints the wrong theme now fails.

/** Execute what the component emitted, the way the browser would. */
function runEmitted(html: string | undefined): void {
  // The point of this test is to RUN the emitted boot script; it is our own
  // text rather than input, and running it is what makes these assertions about
  // behaviour instead of about a substring.
  new Function(html ?? "")();
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("StandaloneTheme", () => {
  it("emits a root-level script that paints the resolved theme on <html>", () => {
    const { container } = render(<StandaloneTheme theme="dark" />);
    const script = container.querySelector("script");
    expect(script).toBeTruthy();
    // Must target the document root (documentElement), not an inner card.
    expect(script?.innerHTML).toContain("documentElement");

    runEmitted(script?.innerHTML);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("paints light at the root when the standalone view is light", () => {
    const { container } = render(<StandaloneTheme theme="light" />);

    runEmitted(container.querySelector("script")?.innerHTML);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
