// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ManageNotFound from "@/components/ManageNotFound";

// #634: the not-found terminal state must not dead-end a lead with one muted
// sentence. It carries Pennie branding, warm copy, and explains the likely
// causes with a path forward (use the link from your confirmation email).

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

  it("offers a path forward via the confirmation email", () => {
    render(<ManageNotFound theme="light" />);
    expect(screen.getByText(/confirmation email/i)).toBeTruthy();
  });

  it("scopes the dark theme via data-theme", () => {
    const { container } = render(<ManageNotFound theme="dark" />);
    expect(container.querySelector('[data-theme="dark"]')).toBeTruthy();
  });
});
