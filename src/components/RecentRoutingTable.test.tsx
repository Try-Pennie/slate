// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  RecentRoutingTable,
  formatRoutingWhen,
  type RecentRoutingRow,
} from "@/components/RecentRoutingTable";

// #905: the recent-routing table extracted from the ~1300-line admin page so it
// can be unit-tested (the #900 row-to-detail-page link couldn't be, forcing a
// test-gate skip). These lock the rendering the admin page used to inline.

const users = [
  { id: "u1", name: "Jamie Smith", email: "jamie@x.co" },
  { id: "u2", name: null, email: "ana@x.co" },
];

const row: RecentRoutingRow = {
  id: "bk1",
  attendee_name: "Jane Doe",
  attendee_email: "jane@acme.co",
  attendee_phone: null,
  starts_at: "2026-07-03T18:00:00Z",
  assigned_user_id: "u1",
  status: "confirmed",
  routing_trace: {
    bucket_code: "DBT-01",
    bucket_id: "b",
    considered: ["u1", "u2"],
    chosen_user_id: "u1",
    fallback_applied: true,
    reassignments: [{ from: "u1", to: "u2", at: "2026-07-02T00:00:00Z" }],
  },
};

describe("formatRoutingWhen", () => {
  it("renders the time in Eastern, not the machine/UTC zone", () => {
    // 6:00 PM UTC on Jul 3 2026 is 2:00 PM Eastern (UTC-4). Pinning the zone
    // makes this deterministic regardless of where the test runs (prod is UTC).
    const out = formatRoutingWhen("2026-07-03T18:00:00Z");
    expect(out).toMatch(/Jul 3/);
    expect(out).toMatch(/2:00/);
    expect(out).toMatch(/PM/);
    expect(out).not.toMatch(/6:00/);
  });
});

describe("RecentRoutingTable", () => {
  it("shows an empty state when there are no bookings", () => {
    render(<RecentRoutingTable rows={[]} users={users} />);
    expect(screen.getByText(/no bookings yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a row with resolved names, trace, and an Open link to the detail page", () => {
    render(<RecentRoutingTable rows={[row]} users={users} />);
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("DBT-01")).toBeTruthy();
    expect(screen.getByText("Jamie Smith")).toBeTruthy();
    expect(screen.getByText(/2 considered · fallback used/)).toBeTruthy();
    // Reassignment resolves both ids, and u2 falls back to its email.
    expect(screen.getByText(/reassigned Jamie Smith → ana@x.co/)).toBeTruthy();
    const open = screen.getByRole("link", { name: /open/i }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("/admin/bookings/bk1");
  });

  it("labels an unassigned agent and shortens an unknown id", () => {
    const unassigned: RecentRoutingRow = { ...row, assigned_user_id: null, routing_trace: null };
    render(<RecentRoutingTable rows={[unassigned]} users={users} />);
    expect(screen.getByText("unassigned")).toBeTruthy();
    expect(screen.getByText("no trace")).toBeTruthy();

    const ghost: RecentRoutingRow = { ...row, assigned_user_id: "abcdef1234567890", routing_trace: null };
    const { container } = render(<RecentRoutingTable rows={[ghost]} users={users} />);
    expect(within(container).getByText("abcdef12")).toBeTruthy();
  });
});
