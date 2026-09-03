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

  // #1789: the stored value is whatever the calendar read threw, and for an
  // OAuth refusal that is a whole pretty-printed JSON body. Interpolated raw it
  // pushes the health summary off the line, so the panel must route it through
  // the one formatter that already exists for this (shortFailureReason). The
  // 401 body is the headline case: an `error` / `error_description` pair.
  const googleUnauthorizedBody = [
    "watch failed: 401 {",
    '  "error": "unauthorized_client",',
    '  "error_description": "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."',
    "}",
  ].join("\n");

  it("shortens a raw Google 401 body to one readable clause", () => {
    render(<SyncHealthPanel agents={[{ ...alice, lane: "watch", error: googleUnauthorizedBody }]} />);
    const text = screen.getByRole("listitem").textContent ?? "";
    // The useful half survives.
    expect(text).toMatch(/401 unauthorized_client/);
    // The body does not. These are the parts that flooded the line.
    expect(text).not.toMatch(/error_description/);
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toMatch(/\n/);
  });

  it("keeps the row a single line for any stored error", () => {
    render(<SyncHealthPanel agents={[{ ...alice, error: googleUnauthorizedBody }]} />);
    const text = screen.getByRole("listitem").textContent ?? "";
    expect(text.split("\n").length).toBe(1);
    // A row is a sentence, not a payload. Well clear of the ~200 char body.
    expect(text.length).toBeLessThan(200);
  });

  // L104: a filter is only trustworthy once it has been tested against the
  // content it must PRESERVE, not only the content it must catch.
  it("passes a short human error through untouched", () => {
    render(<SyncHealthPanel agents={[{ ...alice, error: "404 account-gone" }]} />);
    expect(screen.getByRole("listitem").textContent).toMatch(/404 account-gone/);
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
