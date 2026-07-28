// @vitest-environment jsdom
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

  // #1150: the watch lane got its own failure counter, so a calendar that syncs
  // fine but cannot renew its Google push channel now persists in the data. This
  // panel used to read the sync counter alone; without the lane it would show
  // that agent as "failing to sync", which is false, or not at all.
  it("distinguishes a renewal failure from a sync failure", () => {
    render(
      <SyncHealthPanel
        agents={[
          { ...alice, lane: "watch", error: "watch failed: 401 unauthorized_client" },
        ]}
      />,
    );
    const item = screen.getByRole("listitem");
    expect(item.textContent).toMatch(/renew/i);
    // The row must not claim the calendar is failing to sync, because it is not.
    expect(item.textContent).not.toMatch(/failing to sync/i);
    // Days old is normal for a renewal, so the stamp is labelled as one.
    expect(item.textContent).toMatch(/last renewed/i);
  });

  it("labels a sync failure as a sync failure", () => {
    render(<SyncHealthPanel agents={[{ ...alice, lane: "sync" }]} />);
    const item = screen.getByRole("listitem");
    expect(item.textContent).toMatch(/last ok/i);
    expect(item.textContent).not.toMatch(/renew/i);
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
