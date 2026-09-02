// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #1761: on the Team access panel the Access dropdown and the Give access button
// sat lower than the email field they share a row with.
//
// The cause is structural, not a stray margin. The row aligns its children on
// their BOTTOM edges, and the email column was a div holding a label, the input
// AND the hint sentence, so its bottom edge was the bottom of the hint. The
// Access column has no hint, so its bottom edge is the bottom of the select.
// Aligning those two bottoms pushed the select and the button down by exactly the
// hint's height.
//
// A unit test cannot measure alignment, so it pins the CAUSE: the hint must not
// sit inside the aligned column. That is the thing that can silently come back.

vi.mock("@/app/admin/actions", () => ({
  grantStaffAccess: vi.fn(),
  revokeStaffAccess: vi.fn(),
}));

import { TeamAccessPanel } from "@/components/TeamAccessPanel";

const props = { outcome: null, outcomeEmail: "", outcomeRole: "", pending: [] };

describe("the Team access grant row", () => {
  it("keeps the hint out of the column the row aligns on", () => {
    render(<TeamAccessPanel {...props} />);

    const input = screen.getByLabelText(/Work email address/i);
    const hint = screen.getByText(/The address they sign in to Google with/i);
    const alignedColumn = input.parentElement!;

    // If the hint is inside the input's own column, that column's bottom edge is
    // the hint's bottom, and everything else on the row is pushed down to meet it.
    expect(alignedColumn.contains(hint)).toBe(false);
  });

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

  it("still names the hint as the field's description", () => {
    render(<TeamAccessPanel {...props} />);

    // Moving the hint out of the column must not move it out of the accessibility
    // tree: a sighted reader still sees it under the row, and a screen reader
    // still hears it with the field.
    const input = screen.getByLabelText(/Work email address/i);
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy!);
    expect(hint?.textContent).toMatch(/sign in to Google with/i);
  });
});
