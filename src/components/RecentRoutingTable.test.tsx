// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The viewer's zone is the one input the When column reads from the world, so the
// test sets it rather than inheriting the machine's (L504).
vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => "America/Phoenix" }));

import { RecentRoutingTable, type RecentRoutingRow } from "@/components/RecentRoutingTable";

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

describe("the When column (#1916)", () => {
  it("renders the time in the viewer's zone, with the zone on screen", () => {
    // 18:00 UTC on Jul 3 2026 is 11:00 in Phoenix. It used to be 2:00 PM with no
    // label, in Eastern, on the premise that the whole roster was Eastern.
    render(<RecentRoutingTable rows={[row]} users={users} showCodes />);
    expect(screen.getByText("Fri, Jul 3, 11:00am MST")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/2:00/);
  });
});

describe("RecentRoutingTable", () => {
  it("shows an empty state when there are no bookings", () => {
    render(<RecentRoutingTable rows={[]} users={users} showCodes />);
    expect(screen.getByText(/no bookings yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a row with resolved names, trace, and an Open link to the detail page", () => {
    render(<RecentRoutingTable rows={[row]} users={users} showCodes />);
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("DBT-01")).toBeTruthy();
    expect(screen.getByText("Jamie Smith")).toBeTruthy();
    // #1914: each part of the routing decision is a statement rather than a
    // middot joined fragment.
    expect(screen.getByText("2 agents considered")).toBeTruthy();
    expect(screen.getByText("Fallback used")).toBeTruthy();
    // Reassignment resolves both ids, and u2 falls back to its email.
    expect(screen.getByText(/Reassigned from Jamie Smith to ana@x\.co/)).toBeTruthy();
    const open = screen.getByRole("link", { name: /open/i }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("/admin/bookings/bk1");
  });

  it("says one agent in the singular, so a count of 1 does not read as a typo", () => {
    const one: RecentRoutingRow = {
      ...row,
      routing_trace: { ...row.routing_trace!, considered: ["u1"], fallback_applied: false },
    };
    render(<RecentRoutingTable rows={[one]} users={users} showCodes />);
    expect(screen.getByText("1 agent considered")).toBeTruthy();
    // And the fallback line is absent rather than saying it did not fire.
    expect(screen.queryByText("Fallback used")).toBeNull();
  });

  // #1914. The fallback used to render `id.slice(0, 8)`, which is worse than
  // saying nothing: the smoke agents carry patterned ids, so two DIFFERENT agents
  // both truncated to `c0000000` and a real reassignment read as
  // "reassigned c0000000 to c0000000", a no operation.
  it("says an agent could not be named rather than rendering their id", () => {
    const unassigned: RecentRoutingRow = { ...row, assigned_user_id: null, routing_trace: null };
    render(<RecentRoutingTable rows={[unassigned]} users={users} showCodes />);
    expect(screen.getByText("unassigned")).toBeTruthy();
    expect(screen.getByText("no trace")).toBeTruthy();
    cleanup();

    const ghost: RecentRoutingRow = { ...row, assigned_user_id: "abcdef1234567890", routing_trace: null };
    render(<RecentRoutingTable rows={[ghost]} users={users} showCodes />);
    expect(screen.getByText("not in the roster")).toBeTruthy();
    // No fragment of the id anywhere: an unresolved agent is a detection that
    // the roster is missing somebody, not a name (L67).
    expect(document.body.textContent).not.toMatch(/abcdef/);
  });

  it("does not collapse two unnamed agents into one, which is what a truncated id did", () => {
    const both: RecentRoutingRow = {
      ...row,
      routing_trace: {
        ...row.routing_trace!,
        reassignments: [
          { from: "c00000001111", to: "c00000002222", at: "2026-07-02T00:00:00Z" },
        ],
      },
    };
    render(<RecentRoutingTable rows={[both]} users={users} showCodes />);
    // Two different agents, and the line says it could not name either rather
    // than printing one string twice and reading as a no operation.
    expect(screen.getByText(/Reassigned from not in the roster to not in the roster/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/c0000000/);
  });

  it("gives the reassignment line no link treatment, since it is not a link", () => {
    render(<RecentRoutingTable rows={[row]} users={users} showCodes />);
    const line = screen.getByText(/Reassigned from/);
    // Blue text in a table reads as a link and invites a click that does nothing,
    // and it was colour as the only signal. The word carries the meaning.
    expect(line.className).not.toMatch(/pennie-blue|pennie-sky|underline/);
    expect(line.closest("a")).toBeNull();
  });

  // Dan's call: this is a scan and dig surface, and losing your place in a list
  // of 25 to look at one booking is the complaint.
  it("opens a booking in a new tab, and says so to a screen reader", () => {
    render(<RecentRoutingTable rows={[row]} users={users} showCodes />);
    const open = screen.getByRole("link", { name: /open/i }) as HTMLAnchorElement;
    expect(open.getAttribute("target")).toBe("_blank");
    // Without noopener the new document can reach back through window.opener.
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    // A new window with no warning is a surprise to somebody with no visual cue
    // that anything moved.
    expect(open.textContent).toMatch(/opens in a new tab/i);
  });

  it("names the routing column for what it holds", () => {
    render(<RecentRoutingTable rows={[row]} users={users} showCodes />);
    expect(screen.getByRole("columnheader", { name: "How it routed" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Trace" })).toBeNull();
  });
});

// 2026-10-02 (Dan): a manager never reads a raw bucket code. They read the pool,
// the way staffing depth names it; an admin keeps the code exactly as before.
describe("the bucket column, by who is reading", () => {
  const routed = (code: string, name?: string): RecentRoutingRow => ({
    ...row,
    routing_trace: { ...row.routing_trace!, bucket_code: code },
    ...(name ? { buckets: { name } } : {}),
  });

  it("shows a manager the pool in words and no code", () => {
    render(<RecentRoutingTable rows={[routed("112")]} users={users} showCodes={false} />);
    expect(screen.getByRole("columnheader", { name: "Pool" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Bucket" })).toBeNull();
    expect(screen.getByRole("cell", { name: "Low" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/112/);
  });

  it("names a backend with its tier for a manager", () => {
    render(<RecentRoutingTable rows={[routed("532")]} users={users} showCodes={false} />);
    expect(screen.getByRole("cell", { name: "Ultra High with Achieve" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/532/);
  });

  it("shows a manager the bucket's own name outside the matrix", () => {
    render(
      <RecentRoutingTable rows={[routed("HANDMADE", "Hand made pool")]} users={users} showCodes={false} />,
    );
    expect(screen.getByRole("cell", { name: "Hand made pool" })).toBeTruthy();
  });

  it("shows an admin the code, as today", () => {
    render(<RecentRoutingTable rows={[routed("112")]} users={users} showCodes />);
    expect(screen.getByRole("columnheader", { name: "Bucket" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "112" })).toBeTruthy();
    expect(screen.queryByText("Low")).toBeNull();
  });
});
