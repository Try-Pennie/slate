import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncHealthPanel, type SyncHealthRow } from "@/components/ui/SyncHealthPanel";

// The admin per-agent sync-health surface (#273 Phase 1.3): show the operator
// WHO is failing and how long, so they don't have to hand-query the DB.

const alice: SyncHealthRow = {
  email: "alice@pennie.com",
  name: "Alice Agent",
  consecutiveFailures: 5,
  lastSuccessAt: "2026-06-15T08:00:00Z",
  error: "404 account-gone",
};

describe("SyncHealthPanel", () => {
  it("shows a healthy indicator when nothing is failing", () => {
    render(<SyncHealthPanel agents={[]} />);
    expect(screen.getByText(/syncing/i)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("names each failing agent with count, last success, and error", () => {
    render(<SyncHealthPanel agents={[alice]} />);
    expect(screen.getByText("Alice Agent")).toBeTruthy();
    expect(screen.getByText(/5 consecutive failures/)).toBeTruthy();
    expect(screen.getByText(/2026-06-15/)).toBeTruthy();
    expect(screen.getByText(/404 account-gone/)).toBeTruthy();
    // remediation guidance is present
    expect(screen.getByText(/re-?auth|deactivate/i)).toBeTruthy();
  });

  it("falls back to the email when there's no name, and shows 'never' with no prior success", () => {
    render(
      <SyncHealthPanel
        agents={[{ email: "bob@pennie.com", name: null, consecutiveFailures: 2, lastSuccessAt: null, error: null }]}
      />,
    );
    expect(screen.getByText("bob@pennie.com")).toBeTruthy();
    expect(screen.getByText(/never/i)).toBeTruthy();
  });

  it("renders one list item per failing agent", () => {
    render(
      <SyncHealthPanel
        agents={[alice, { email: "b@p.com", name: "Bee", consecutiveFailures: 1, lastSuccessAt: null, error: null }]}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });
});
