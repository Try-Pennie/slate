// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #1761: on the Team access panel the Access dropdown and the Give access button
// sat lower than the email field they share a row with.
//
// The cause was structural, not a stray margin. The row aligns its children on
// their BOTTOM edges, and the email column was a div holding a label, the input
// AND a hint sentence, so its bottom edge was the bottom of the hint. The Access
// column has no hint, so its bottom edge is the bottom of the select. Aligning
// those two bottoms pushed the select and the button down by exactly the hint's
// height.
//
// #1889 REMOVED THE HINT, along with the label text and the placeholder. Two of
// the three tests in this file were about the hint's position and its
// `aria-describedby`, and their whole content was the thing being removed, so
// they are deleted rather than adjusted (L252). What replaced them lives in
// TeamAccessPanel.test.tsx: the field keeps an accessible name from a visually
// hidden label, and there is no describedby left pointing at nothing.
//
// What survives is the rule the hint broke, which is still worth pinning because
// the next thing added to that column breaks it again in exactly the same way:
// the three controls share one row, so they align against each other rather than
// each finding its own baseline.

vi.mock("@/app/admin/actions", () => ({
  grantStaffAccess: vi.fn(),
  revokeStaffAccess: vi.fn(),
}));

import { TeamAccessPanel } from "@/components/TeamAccessPanel";

const props = { outcome: null, outcomeEmail: "", outcomeRole: "", pending: [] };

describe("the Team access grant row", () => {
  it("keeps the three controls on one row as siblings", () => {
    render(<TeamAccessPanel {...props} />);

    const input = screen.getByLabelText(/Work email address/i);
    const select = screen.getByLabelText(/^Access$/i);
    const button = screen.getByRole("button", { name: /Give access/i });

    // One shared row: each control's column has the same parent, so they are
    // aligned against each other rather than each finding its own baseline.
    // The row is the nearest ancestor carrying the bare `flex` class. Matched as
    // a class TOKEN, not a substring: `min-w-0 flex-1` contains "flex" and is a
    // column, so a substring test stops one level early and every comparison
    // below is between an element and its own parent.
    const isRow = (el: Element) => el.classList.contains("flex");
    const columnOf = (el: HTMLElement) => {
      let node: HTMLElement = el;
      while (node.parentElement && !isRow(node.parentElement)) {
        node = node.parentElement;
      }
      return node.parentElement;
    };
    expect(columnOf(select)).toBe(columnOf(input));
    expect(columnOf(button)).toBe(columnOf(input));
  });

  // The reason the rule above still matters after the hint is gone: nothing may
  // be added under the input inside its own column, or the row tilts again.
  it("holds nothing under the input inside the column the row aligns on", () => {
    render(<TeamAccessPanel {...props} />);

    const input = screen.getByLabelText(/Work email address/i);
    const alignedColumn = input.parentElement as HTMLElement;
    // The visually hidden label is allowed (it draws nothing). Anything that
    // OCCUPIES space below the input is what pushes the row.
    const visible = [...alignedColumn.children].filter(
      (el) => el !== input && !el.className.includes("sr-only"),
    );
    expect(visible).toHaveLength(0);
  });
});
