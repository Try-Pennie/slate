// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";

// #160: the rendered Team access panel.
//
// This was written when CI had no browser layer. The browser leg added on
// 2026-10-03 (ADR 0011) runs axe over the admin pages but does not walk these
// states, so this is still what proves the panel's states are actually distinct
// on screen rather than distinct in a pure function nobody rendered. Three
// things it exists to hold:
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
  // #1889 stripped three pieces of copy off the email field: the label text, the
  // placeholder (which was not our address format, so it read as instruction and
  // was wrong) and the hint. The label ELEMENT stays, visually hidden, because it
  // is what a screen reader announces and an unnamed edit box fails 4.1.2.
  //
  // The describedby assertion that used to sit here is gone rather than adjusted:
  // its whole content was the hint being removed (L252).
  it("keeps an accessible name on the address field with nothing shown above it", () => {
    render(panel());
    const input = screen.getByLabelText(/work email address/i) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(screen.getByLabelText(/^access$/i)).toBeTruthy();

    // Hidden from sight, not from assistive tech.
    expect(document.querySelector('label[for="staff-email"]')?.className).toContain("sr-only");
    // A describedby pointing at an element that does not exist reads no
    // description and raises no error anywhere, so it looks fine.
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("staff-email-hint")).toBeNull();
    // And the placeholder is gone with it: we know what an email looks like.
    expect(input.getAttribute("placeholder")).toBeNull();
  });

  // #1907: the panel does not title or explain itself, because the page it is
  // the whole content of already does. Two headings reading "Team access" one
  // card apart, each with its own description, is what this removes. Asserted
  // from the PANEL's side, since that is the half that has to stay quiet: the
  // page header is the one place the name belongs.
  it("does not name or explain itself, because the page around it does", () => {
    render(panel());
    expect(screen.queryByRole("heading", { name: /^team access$/i })).toBeNull();
    expect(screen.queryByText(/not debt team agents/i)).toBeNull();
    // The controls it exists for are all still there.
    expect(screen.getByLabelText(/work email address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /give access/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /waiting for a first sign in/i })).toBeTruthy();
  });

  // #1890: the paragraph over the pending list explained its own heading, and
  // every row already carries what it was spelling out.
  it("does not explain what waiting for a first sign in means", () => {
    render(panel());
    expect(screen.getByRole("heading", { name: /waiting for a first sign in/i })).toBeTruthy();
    expect(screen.queryByText(/Access nobody has used yet/i)).toBeNull();
    expect(screen.queryByText(/looks exactly like nothing happening/i)).toBeNull();
  });

  // #1849: the control is a picker of our own now, so its rows exist only while
  // it is open. The assertion is unchanged: which roles are offered, and that
  // super admin is never among them.
  it("offers the elevated roles and never super admin, which is not minted from a typed address", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("combobox", { name: /^access$/i }));
    const labels = screen.getAllByRole("option").map((o) => o.textContent?.trim());
    // #4205: and the scheduling coordinator, granted before their first sign in.
    expect(labels).toEqual(["manager", "team lead", "admin", "coordinator"]);
    expect(labels).not.toContain("super admin");
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
          row({ lookalike: { id: "u2", email: "geoff.smith@trypennie.com", role: "agent" } }),
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

  // #1669. The button posted the PENDING row's role and nothing consulted the
  // lookalike's own. A seeded manager row beside a real account since made admin
  // rendered "Give manager access to geoff.smith", and one click demoted him.
  it("offers no button when the lookalike already holds that access or more", () => {
    render(
      panel({
        pending: [
          row({
            role: "manager",
            lookalike: { id: "u2", email: "geoff.smith@trypennie.com", role: "admin" },
          }),
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: /give .* access to geoff/i })).toBeNull();
    expect(screen.getByText(/already has/i)).toBeTruthy();
  });

  it("still offers the button when the lookalike would genuinely gain access", () => {
    render(
      panel({
        pending: [
          row({
            role: "manager",
            lookalike: { id: "u2", email: "geoff.smith@trypennie.com", role: "agent" },
          }),
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: /give manager access to geoff\.smith@trypennie\.com/i }),
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

// #1891. Five rows, and the access pill, the wait and the flag started at a
// different horizontal position on every one of them.
//
// Each person was one `flex flex-wrap` row, where an item's position is set by
// the total width of everything before it, so the varying address length decided
// where the other three landed. That is not a spacing value to nudge: a flow row
// has no columns to align. `flex-wrap` also dropped the flag onto a second line
// on some rows and not others, so the rows stopped having the same shape too.
describe("the waiting list is a table with columns (#1891)", () => {
  const three = [
    row({ id: "a", email: "geoff@trypennie.com", name: "Geoff Smith", waitedDays: 79 }),
    row({ id: "b", email: "mrasmussen@trypennie.com", name: null, waitedDays: 83, stale: false }),
    row({ id: "c", email: "kim@trypennie.com", name: "Kim Ito", waitedDays: 3, stale: false }),
  ];

  it("reads as a table with named column headers, so the columns exist at all", () => {
    render(panel({ pending: three }));
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    for (const name of ["Person", "Access", "Waiting", "Flag"]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
  });

  it("puts each row's four values in the four columns, in the same order every time", () => {
    render(panel({ pending: three }));
    const bodyRows = screen.getAllByRole("row").filter((r) => r.querySelectorAll("td").length === 4);
    expect(bodyRows).toHaveLength(3);

    for (const r of bodyRows) {
      const cells = [...r.querySelectorAll("td")];
      // The comparison the flow row could not do: cell N is the same field on
      // every row, whatever the address length in cell 1.
      expect(cells).toHaveLength(4);
    }
    const first = [...bodyRows[0].querySelectorAll("td")].map((c) => c.textContent?.trim());
    expect(first[0]).toContain("Geoff Smith");
    expect(first[0]).toContain("geoff@trypennie.com");
    expect(first[1]).toBe("admin");
    expect(first[2]).toMatch(/79 days/);
    expect(first[3]).toMatch(/Check this address/);
    // An unflagged row leaves the column empty rather than shifting the others.
    expect([...bodyRows[1].querySelectorAll("td")][3].textContent).toBe("");
  });

  it("aligns the wait on its digits, in the header as well as the cells", () => {
    render(panel({ pending: three }));
    const header = screen.getByRole("columnheader", { name: "Waiting" });
    expect(header.className).toContain("text-right");
    const cell = [...screen.getAllByRole("row").filter((r) => r.querySelectorAll("td").length === 4)[0]
      .querySelectorAll("td")][2];
    // Both, because a column's header alignment and its cells' are one fact set
    // at two independent declaration sites (L553).
    expect(cell.className).toContain("text-right");
    expect(cell.className).toContain("tabular-nums");
  });

  it("renders an address with no name without leaving a gap where the name would be", () => {
    render(panel({ pending: [three[1]] }));
    const cell = screen.getAllByRole("cell")[0];
    expect(cell.textContent?.trim()).toBe("mrasmussen@trypennie.com");
  });

  it("keeps a lookalike attached to the person it is about", () => {
    render(
      panel({
        pending: [
          three[2],
          row({
            id: "d",
            email: "geof.smith@trypennie.com",
            name: "Geoff Smith",
            lookalike: { id: "u2", email: "geoff.smith@trypennie.com", role: "agent" },
          }),
        ],
      }),
    );
    const rows = screen.getAllByRole("row");
    const person = rows.find((r) => r.textContent?.includes("geof.smith@trypennie.com"));
    const panelRow = rows.find((r) => r.querySelector("td")?.getAttribute("colspan") === "4");
    expect(person).toBeTruthy();
    expect(panelRow).toBeTruthy();
    // Directly beneath its person, spanning every column, and with no separator
    // between the two: which row the remedy belongs to is the one thing that has
    // to survive being made a table.
    expect(person!.nextElementSibling).toBe(panelRow);

    // The MECHANISM, not one row's class list. `divide-y` on the body draws a
    // line between every pair of rows, including this pair, and it does it from
    // the body's class rather than the row's, so an assertion that only reads
    // `panelRow.className` passes while a line is drawn straight through the
    // thing this test is about (L63).
    const body = panelRow!.parentElement as HTMLElement;
    expect(body.tagName).toBe("TBODY");
    expect(body.className).not.toContain("divide-y");
    expect(panelRow!.className).not.toContain("border-t");
    // And the people are still separated FROM EACH OTHER, so removing the body
    // rule did not just delete every line on the table.
    const people = rows.filter((r) => r.querySelectorAll("td").length === 4);
    expect(people[0].className).not.toContain("border-t");
    expect(people[1].className).toContain("border-t");
  });

  // The three states stay distinct, and the unreadable one is not a row inside
  // the table: it is the panel saying it cannot answer.
  it("shows the unreadable roster as an alert rather than as a table", () => {
    render(panel({ pending: null }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/not the same as nobody waiting/i);
  });

  it("shows the empty state as a sentence rather than an empty table", () => {
    render(panel({ pending: [] }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/has signed in at least once/i)).toBeTruthy();
  });
});
