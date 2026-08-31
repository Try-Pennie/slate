// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #160: the rendered Team access panel.
//
// There is no browser layer in CI here (see AGENTS.md), so this is what proves
// the panel's states are actually distinct on screen rather than distinct in a
// pure function nobody rendered. Three things it exists to hold:
//
//  * COULD NOT READ vs NOBODY WAITING. This is the panel somebody opens because
//    access is not working. An unreadable roster rendered as "everyone has signed
//    in" is the reassuring way to be wrong, on exactly the wrong screen (L10).
//  * The overdue flag is WORDS, not a colour, so it survives being read by
//    somebody who cannot see the outline.
//  * The form controls carry real labels, reachable by their visible text.
vi.mock("@/app/admin/actions", () => ({ grantStaffAccess: vi.fn() }));

import { TeamAccessPanel } from "./TeamAccessPanel";
import type { PendingAccessRow } from "@/lib/admin/pending-access";

function row(over: Partial<PendingAccessRow> = {}): PendingAccessRow {
  return {
    id: "u1",
    email: "geof.smith@trypennie.com",
    name: "Geoff Smith",
    role: "admin",
    waitedDays: 9,
    stale: true,
    lookalike: null,
    ...over,
  };
}

function panel(over: Partial<Parameters<typeof TeamAccessPanel>[0]> = {}) {
  return (
    <TeamAccessPanel
      outcome={null}
      outcomeEmail=""
      outcomeRole=""
      pending={[]}
      {...over}
    />
  );
}

describe("TeamAccessPanel", () => {
  it("labels the address and access controls so they are reachable by their visible text", () => {
    render(panel());
    expect(screen.getByLabelText(/work email address/i)).toBeTruthy();
    expect(screen.getByLabelText(/^access$/i)).toBeTruthy();
    // The hint is associated, not merely adjacent.
    const input = screen.getByLabelText(/work email address/i) as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/sign in to Google/i);
  });

  it("offers the elevated roles and never super admin, which is not minted from a typed address", () => {
    render(panel());
    const options = Array.from(
      (screen.getByLabelText(/^access$/i) as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["manager", "team_lead", "admin"]);
  });

  it("says the roster could not be read, and does NOT say everyone has signed in", () => {
    render(panel({ pending: null }));
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read/i);
    expect(screen.queryByText(/has signed in at least once/i)).toBeNull();
  });

  it("says nobody is waiting only when the roster really was readable and empty", () => {
    render(panel({ pending: [] }));
    expect(screen.getByText(/has signed in at least once/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the wait, and flags an overdue one in words rather than by colour alone", () => {
    render(panel({ pending: [row()] }));
    expect(screen.getByText("geof.smith@trypennie.com")).toBeTruthy();
    expect(screen.getByText(/waiting 9 days/i)).toBeTruthy();
    expect(screen.getByText(/check this address/i)).toBeTruthy();
  });

  it("names the signed in address that looks like the same person, and offers it as the fix", () => {
    render(
      panel({
        pending: [
          row({ lookalike: { id: "u2", email: "geoff.smith@trypennie.com" } }),
        ],
      }),
    );
    expect(screen.getByText("geoff.smith@trypennie.com")).toBeTruthy();
    // The remedy is a control, not advice: a suggestion with nothing to press
    // leaves the person exactly where the panel found them.
    expect(
      screen.getByRole("button", { name: /give admin access to geoff\.smith@trypennie\.com/i }),
    ).toBeTruthy();
  });

  it("renders a refusal as an alert and a grant as a status, so the two do not read alike", () => {
    const { unmount } = render(
      panel({ outcome: "last_admin", outcomeEmail: "someone@trypennie.com" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/no admin/i);
    unmount();

    render(panel({ outcome: "granted", outcomeEmail: "someone@trypennie.com", outcomeRole: "admin" }));
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/someone@trypennie\.com/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
