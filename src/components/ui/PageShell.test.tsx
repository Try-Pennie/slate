// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageShell, PAGE_WIDTHS } from "@/components/ui/PageShell";

// #1745: every internal page hard coded its own max-width on its own <main>, and
// the 13 of them disagreed: /me capped at 672px, /admin at 896px,
// /admin/bucket-availability at 1152px. So the admin home used about half of a
// wide window, and moving between pages changed the content width underneath you.
//
// PageShell is the one place the width is decided. These tests pin what a page
// gets by using it: the skip-link target, a width from the shared table, and a
// narrow variant that is genuinely narrower than the default.

describe("PageShell", () => {
  it("is the page's <main> and carries the skip-link target", () => {
    render(<PageShell>content</PageShell>);

    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    // Safari will not focus a non-focusable fragment target, so without this the
    // skip link scrolls and leaves focus on the link (#1054).
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("uses the wide cap when no width is asked for", () => {
    render(<PageShell>content</PageShell>);

    expect(screen.getByRole("main").className).toContain(PAGE_WIDTHS.wide);
  });

  it("uses the narrow cap when a page opts into it", () => {
    render(<PageShell width="narrow">content</PageShell>);

    const cls = screen.getByRole("main").className;
    expect(cls).toContain(PAGE_WIDTHS.narrow);
    expect(cls).not.toContain(PAGE_WIDTHS.wide);
  });

  it("offers exactly two widths, and narrow is really narrower than wide", () => {
    // A third variant would recreate the problem this component exists to fix,
    // 13 pages each picking a number, one indirection further along. And two
    // variants that resolve to the SAME cap would read as a choice while making
    // none.
    expect(Object.keys(PAGE_WIDTHS).sort()).toEqual(["narrow", "wide"]);
    const rem = (cap: string) => {
      const n = Number(cap.match(/max-w-\[(\d+(?:\.\d+)?)rem\]/)?.[1]);
      expect(Number.isFinite(n)).toBe(true);
      return n;
    };
    expect(rem(PAGE_WIDTHS.narrow)).toBeLessThan(rem(PAGE_WIDTHS.wide));
  });

  it("renders what it is given", () => {
    render(
      <PageShell>
        <h1>Slate admin</h1>
      </PageShell>,
    );

    expect(screen.getByRole("heading", { name: "Slate admin" })).toBeTruthy();
  });
});
