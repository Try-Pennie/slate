import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import StandaloneTheme from "@/components/StandaloneTheme";

// #706: standalone lead-facing pages render inside the root layout, whose <html>
// is pinned to data-theme="light". Setting data-theme only on an inner content
// element left the document root (html/body) beige, showing as a gutter at the
// scrollbar/overflow edges in dark mode. This component paints the theme at the
// document root so there is no beige gutter.

describe("StandaloneTheme", () => {
  it("emits a root-level script that paints the resolved theme on <html>", () => {
    const { container } = render(<StandaloneTheme theme="dark" />);
    const script = container.querySelector("script");
    expect(script).toBeTruthy();
    // Must target the document root (documentElement), not an inner card.
    expect(script?.innerHTML).toContain("documentElement");
    expect(script?.innerHTML).toContain("data-theme");
    expect(script?.innerHTML).toContain("dark");
  });

  it("paints light at the root when the standalone view is light", () => {
    const { container } = render(<StandaloneTheme theme="light" />);
    const script = container.querySelector("script");
    expect(script?.innerHTML).toContain("light");
    expect(script?.innerHTML).not.toContain("dark");
  });
});
