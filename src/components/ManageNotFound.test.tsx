// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ManageNotFound from "@/components/ManageNotFound";
import { NOT_FOUND_COPY } from "@/lib/booking/manage-copy";

// #634: the not-found terminal state must not dead-end a lead with one muted
// sentence. It carries Pennie branding, warm copy, and explains the likely
// causes with a path forward.
//
// #2364: that path forward used to be "the most recent confirmation email from
// Pennie", which Pennie does not send. The recovery is real and lives in the
// calendar invitation the advisor sent, so that is what the screen names, and the
// words come from `manage-copy` so they can be read before they ship.

describe("ManageNotFound", () => {
  it("shows Pennie branding, not a bare muted sentence", () => {
    render(<ManageNotFound theme="light" />);
    // At least one Pennie logo is present (light/dark variants both render, CSS toggles).
    expect(screen.getAllByAltText("Pennie").length).toBeGreaterThan(0);
  });

  it("explains the likely causes of a missing booking", () => {
    render(<ManageNotFound theme="light" />);
    // Names why the link may be dead: expired, already cancelled, or mistyped.
    expect(screen.getByText(/expired|cancelled|no longer/i)).toBeTruthy();
  });

  it("points at the calendar invitation, which is the only thing Pennie sends", () => {
    render(<ManageNotFound theme="light" />);
    expect(screen.getByText(NOT_FOUND_COPY.recovery)).toBeTruthy();
    // And says nothing about an email, which is the instruction that sent a lead
    // searching an inbox for something that was never there.
    expect(document.body.textContent).not.toMatch(/confirmation email/i);
  });

  it("scopes the dark theme via data-theme", () => {
    const { container } = render(<ManageNotFound theme="dark" />);
    expect(container.querySelector('[data-theme="dark"]')).toBeTruthy();
  });
});
