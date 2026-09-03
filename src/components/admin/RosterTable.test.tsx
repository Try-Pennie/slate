// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1752: the whole point is that filtering costs NO round trip. A test that only
// checked the right rows are shown would pass just as well over the navigation
// this change removes, so the router is mocked and asserted to stay untouched.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/agents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/admin/actions", () => ({ startImpersonation: vi.fn() }));

import { RosterTable } from "@/components/admin/RosterTable";
import { EMPTY_ROSTER_FILTERS, ROSTER_PAGE_SIZE } from "@/lib/admin/roster-filter";
import type { RosterRow } from "@/lib/admin/roster-filter";

const row = (id: string, name: string, extra: Partial<RosterRow> = {}): RosterRow => ({
  id,
  name,
  email: `${id}@x.com`,
  role: "agent",
  bookable: true,
  manager_id: null,
  deactivated_at: null,
  attributes: {},
  avatar_url: null,
  ...extra,
});

const ROWS: RosterRow[] = [
  row("a", "Ada Lovelace"),
  row("b", "Grace Hopper", { role: "manager", bookable: false }),
  row("c", "Alan Turing", { role: "admin" }),
];

const base = {
  rows: ROWS,
  initialFilters: EMPTY_ROSTER_FILTERS,
  actorRole: "super_admin" as const,
  actorId: "me",
  roleOptions: ["agent", "manager", "admin"] as const,
  teamOptions: [] as string[],
  managerOptions: [] as [string, string][],
};

const bodyRows = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the address BEFORE spying, or the spy counts this call as the
  // component's and every "did not write the URL" assertion is already false.
  window.history.replaceState(null, "", "/admin/agents");
  vi.spyOn(window.history, "replaceState");
});

afterEach(() => vi.restoreAllMocks());


// #1849: the filters are a picker of our own now rather than native selects, so
// they are driven by opening the list and clicking a row. The ASSERTIONS below
// are unchanged; only how a filter is set has moved. One helper, so a later test
// does not invent a second way of doing it.
async function pickFilter(label: RegExp | string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("RosterTable", () => {
  it("filters as you type, with no Search button to press", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
    expect(bodyRows()).toHaveLength(3);

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "grace");

    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    // The button is the thing #1752 removes; a no-JavaScript one lives in
    // <noscript>, which jsdom does not expose as a control.
    expect(screen.queryByRole("button", { name: /^Search$/i })).toBeNull();
  });

  it("does not navigate to filter, which is the entire change", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "ada");
    await pickFilter(/Filter by role/i, "agent");

    // A router call here re-renders the whole force-dynamic page and re-runs every
    // read on it, which is the cost this exists to remove.
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("keeps the filters in the URL, written without a render", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "ada");
    await vi.advanceTimersByTimeAsync(400);

    expect(window.history.replaceState).toHaveBeenCalled();
    expect(window.location.search).toContain("q=ada");
    vi.useRealTimers();
  });

  it("filters on the keystroke, not on the debounce", () => {
    // The URL write is debounced; the filtering is not. Debouncing the filter is
    // debouncing the only thing the person is waiting for.
    //
    // fireEvent rather than userEvent, and no awaits after it: the assertions run
    // in the same tick as the change, so a filter that waited for the 250ms timer
    // would still be showing three rows here. Real timers, so nothing can advance
    // the debounce underneath the assertion either.
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);

    fireEvent.change(screen.getByLabelText(/Search by name or email/i), {
      target: { value: "grace" },
    });

    expect(bodyRows()).toHaveLength(1);
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("starts from the filters the URL arrived with", () => {
    render(
      <RosterTable
        {...base}
        roleOptions={[...base.roleOptions]}
        initialFilters={{ ...EMPTY_ROSTER_FILTERS, role: "manager" }}
      />,
    );

    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });

  it("says so when nothing matches, rather than showing an empty table", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "zzzz");

    expect(screen.getByText('Nothing matches "zzzz".')).toBeTruthy();
  });

  // #1791: a trailing space filters now, so an accidental one empties the table
  // for a reason nobody can see. The quotes are what make the space visible.
  it("shows the trailing space inside the quotes when a search finds nobody", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "zzzz ");

    expect(screen.getByText('Nothing matches "zzzz ".')).toBeTruthy();
  });

  it("distinguishes an empty roster from a filter that matched nothing", () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={[]} />);

    // Different causes, different sentences: "no agents yet" and "your filter
    // matched nobody" send you to different places.
    expect(screen.getByText(/No agents yet/i)).toBeTruthy();
    expect(screen.queryByText(/matches those filters/i)).toBeNull();
  });

  // #1799: the count read "showing 1 to 5 of 5 (of 136)".
  describe("the result count", () => {
    const count = () =>
      document.querySelector('[aria-live="polite"]')!.textContent;

    it("gives the total alone when nothing is filtered", () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      expect(count()).toBe("3 agents");
    });

    // This carries the intent of the test it replaced: the readout is the only
    // thing that says a filter is hiding people, so when people ARE hidden it has
    // to name both numbers. That test chose a query matching every row, which is
    // the one case where nothing is hidden and naming both is wrong.
    it("says how many matched out of the roster once a filter is on", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      await userEvent.type(screen.getByLabelText(/Search by name or email/i), "ada");
      expect(count()).toBe("1 of 3 agents");
    });

    it("says no matches when a filter finds nobody", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      await userEvent.type(screen.getByLabelText(/Search by name or email/i), "zzzz");
      expect(count()).toBe("No matches");
    });

    // Found by looking at the real page: with no filter on it read
    // "117 of 136 agents", because the number handed in counted offboarded
    // people too, and `filterRoster` treats those as not on the roster at all.
    // So an unfiltered roster looked like a filtered one. The total is DERIVED
    // from the rows now, so no caller can supply a different one (L63).
    it("counts only people who are on the roster, not offboarded ones", () => {
      const rows = [
        row("x", "Active One"),
        row("y", "Active Two"),
        row("z", "Gone", { deactivated_at: "2026-01-01T00:00:00Z" }),
      ];
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={rows} />);
      expect(count()).toBe("2 agents");
    });

    it("counts nothing at all for an empty roster", () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={[]} />);
      expect(count()).toBe("");
    });

    it("never shows the same number twice, whatever is filtered", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      // A filter matching everybody: "3 of 3" would be one fact as two numbers.
      await userEvent.type(screen.getByLabelText(/Search by name or email/i), "a");
      const numbers = (count() ?? "").match(/\d+/g) ?? [];
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  // #1823: the column was headed "Bookable" and every bookable row said
  // "Bookable", and the negative state got a hyphen rather than a mark.
  describe("the Bookable column", () => {
    it("says Yes and No, and says Bookable only in the header", () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const table = screen.getByRole("table");
      expect((table.textContent!.match(/Bookable/g) ?? []).length).toBe(1);
      expect(screen.getByRole("columnheader", { name: "Bookable" })).toBeTruthy();
      // ROWS has two bookable and one not.
      expect(screen.getAllByText("Yes")).toHaveLength(2);
      expect(screen.getAllByText("No")).toHaveLength(1);
    });

    it("draws a pill for the negative state too, never a hyphen", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const marks = screen.getByRole("table").querySelectorAll("[data-bookable-mark]");
      expect(marks).toHaveLength(3);
      expect(Array.from(marks).map((m) => m.getAttribute("data-bookable-mark")).sort()).toEqual([
        "filled",
        "filled",
        "hollow",
      ]);
    });
  });

  // #1812: the drawn glyph is replaced by ledger letters, and the sentence that
  // sat beside it is gone from the column.
  describe("the Team column", () => {
    it("spends no row on the word Covers", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const table = screen.getByRole("table");
      expect(table.textContent).not.toMatch(/Covers/);
      // The control: the column really is drawing something, so an empty cell
      // cannot be what satisfies the line above (L98).
      expect(table.querySelectorAll("[data-ledger]").length).toBe(3);
      expect(table.querySelectorAll("[data-rung]").length).toBe(15);
    });

    it("explains the letters once, on the header, not per row", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const header = screen.getByRole("columnheader", { name: /Team/ });
      expect(header.getAttribute("title")).toMatch(/V Very High/);
      expect(header.getAttribute("title")).toMatch(/U Ultra High/);
      // Once, not 136 times: the expansion appears in exactly one place.
      const table = screen.getByRole("table");
      expect((table.textContent!.match(/Ultra High/g) ?? []).length).toBe(1);
    });

    it("still names the tiers in words for a reader who cannot see letters", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const glyphs = screen.getByRole("table").querySelectorAll("[data-ledger]");
      for (const g of Array.from(glyphs)) {
        expect(g.getAttribute("aria-label")).toBeTruthy();
        expect(g.getAttribute("role")).toBe("img");
      }
    });
  });

  // #1794, Dan: "let's collapse this two into a menu in each line... like a 3
  // dot menu is fine". The controls spelled the agent's whole name into a narrow
  // column, so "View as Kenneth Johnson" wrapped to three lines and every row was
  // a different height.
  describe("the per row actions menu", () => {
    it("gives each row exactly one trigger, named for that agent", () => {
      // A table of identical "More" buttons is a control addressed by position
      // rather than by identity (L237), so the trigger names the row even though
      // the glyph does not.
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const triggers = screen.getAllByRole("button", { name: /^Actions for / });
      expect(triggers).toHaveLength(3);
      expect(screen.getByRole("button", { name: "Actions for Ada Lovelace" })).toBeTruthy();
    });

    it("keeps the agent's name out of the visible label", () => {
      // The row height symptom, pinned by the cause rather than by pixels: no
      // name in the label means nothing to wrap.
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const trigger = screen.getByRole("button", { name: "Actions for Ada Lovelace" });
      expect(trigger.textContent).not.toMatch(/Ada|Lovelace/);
    });

    it("hides both actions until the menu is opened", () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.queryByRole("link", { name: "Manage" })).toBeNull();
    });

    it("offers View as and Manage inside the open menu", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      await userEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));
      const items = screen.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual(["View as Ada Lovelace", "Manage"]);
    });

    it("submits View as through a form rather than navigating", async () => {
      // It posts an action, which is what gives it the in flight feedback from
      // #1786. An anchor would break impersonation or silently lose that.
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      await userEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));
      const viewAs = screen.getByRole("menuitem", { name: "View as Ada Lovelace" });
      expect(viewAs.tagName).toBe("BUTTON");
      expect(viewAs.getAttribute("type")).toBe("submit");
      const form = viewAs.closest("form");
      expect(form).toBeTruthy();
      // The form is between role=menu and its menuitem, which that role does not
      // allow, so it is removed from the accessibility tree rather than left as a
      // stray non-item child.
      expect(form!.getAttribute("role")).toBe("none");
    });

    it("puts nothing but menu items in the menu, to assistive tech", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      await userEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));
      const menu = screen.getByRole("menu");
      for (const child of Array.from(menu.children)) {
        const role = child.getAttribute("role");
        expect(["menuitem", "none"], `<${child.tagName.toLowerCase()}>`).toContain(role);
      }
    });

    it("still shows a menu on a row nobody may view as, with Manage alone in it", async () => {
      // Impersonation carries a role ceiling and never applies to your own row,
      // so one of the two items is often absent. The menu is rendered anyway:
      // a control that moves depending on who you are is harder to scan than one
      // extra click, so every row has the same shape.
      render(
        <RosterTable {...base} roleOptions={[...base.roleOptions]} actorId="a" />,
      );
      const trigger = screen.getByRole("button", { name: "Actions for Ada Lovelace" });
      await userEvent.click(trigger);
      const items = screen.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual(["Manage"]);
      expect(screen.queryByRole("menuitem", { name: /View as/ })).toBeNull();
    });

    it("closes on Escape and hands focus back to that row's trigger", async () => {
      render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
      const trigger = screen.getByRole("button", { name: "Actions for Grace Hopper" });
      await userEvent.click(trigger);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("clears every filter at once", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "ada");
    await pickFilter(/Filter by bookable/i, "Bookable");
    expect(bodyRows()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /clear/i }));

    expect(bodyRows()).toHaveLength(3);
  });

  it("pages in the browser, with no navigation", async () => {
    const many = Array.from({ length: ROSTER_PAGE_SIZE + 5 }, (_, i) =>
      row(`u${i}`, `Person ${String(i).padStart(3, "0")}`),
    );
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={many} />);
    expect(bodyRows()).toHaveLength(ROSTER_PAGE_SIZE);

    await userEvent.click(screen.getByRole("button", { name: /Next/i }));

    expect(bodyRows()).toHaveLength(5);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("returns to the first page when the filter changes", async () => {
    const many = Array.from({ length: ROSTER_PAGE_SIZE + 5 }, (_, i) =>
      row(`u${i}`, `Person ${String(i).padStart(3, "0")}`),
    );
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={many} />);
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "Person 0");

    // Otherwise a narrower filter leaves you on page 2 of a one page list, which
    // renders as an empty table over a filter that matched plenty.
    expect(bodyRows().length).toBeGreaterThan(0);
  });

});

// #1844: Team comes before Role.
//
// Dan, 2026-09-03: "swap the role and team columns so team comes first". Two
// halves have to move together, the header and the cell, and the defect this
// class produces is a header that moved without its data, so both are asserted
// in ONE test rather than in two that could each pass over a transposed table.
//
// The filter row above the table is the same two fields in the same order, so it
// is asserted here too: one fact declared in two places drifts, and the drift is
// invisible because each place reads correctly on its own (L263).
describe("column order (#1844)", () => {
  const HEADERS = ["Member", "Team", "Role", "Manager", "Bookable"];
  // `base.roleOptions` is `as const`; the prop wants a mutable array.
  const props = { ...base, roleOptions: [...base.roleOptions] };

  it("puts Team before Role in the header AND in the cells", () => {
    render(<RosterTable {...props} teamOptions={["Auto"]} />);

    const headerRow = screen.getAllByRole("row")[0]!;
    const headings = within(headerRow)
      .getAllByRole("columnheader")
      .map((th) => (th.textContent ?? "").trim())
      .filter((t) => t.length > 0)
      // The Team header carries the ledger legend for screen readers; compare on
      // the visible word rather than on the legend riding along with it.
      .map((t) => (t.startsWith("Team") ? "Team" : t));
    expect(headings).toEqual(HEADERS);

    // Grace Hopper is a manager, so her Role cell is the one whose position is
    // unambiguous: an agent's cell says "Agent" and could be confused with a
    // team name, a manager's cannot.
    const graceRow = screen.getByText("Grace Hopper").closest("tr")!;
    const cells = within(graceRow).getAllByRole("cell");
    // Case-insensitive: the label is lowercase in the DOM and capitalised by CSS,
    // so asserting the rendered casing would be asserting the stylesheet.
    expect(cells[2]!.textContent).toMatch(/manager/i);
    // ...and the cell BEFORE it is the ledger, not the role. This is the half a
    // header-only assertion cannot see.
    expect(cells[1]!.textContent).not.toMatch(/manager/i);
  });

  it("keeps the ledger legend attached to the Team header after the move", () => {
    render(<RosterTable {...props} teamOptions={["Auto"]} />);
    const teamHeader = screen
      .getAllByRole("columnheader")
      .find((th) => (th.textContent ?? "").startsWith("Team"))!;
    expect(teamHeader.getAttribute("title")).toBeTruthy();
    expect(teamHeader.textContent).toMatch(/V\b|Verified|[A-Z]/);
  });

  it("orders the filter controls the same way the columns are ordered", () => {
    const managerOptions: [string, string][] = [["b", "Grace"]];
    render(
      <RosterTable {...props} teamOptions={["Auto"]} managerOptions={managerOptions} />,
    );
    const selects = Array.from(
      document.querySelectorAll('input[type="hidden"]'),
    ).map((s) => (s as HTMLInputElement).name);
    expect(selects.indexOf("team")).toBeLessThan(selects.indexOf("role"));
    // A positive control on the comparison above: both are really present, so a
    // pair of -1s cannot satisfy it (L98).
    expect(selects).toContain("team");
    expect(selects).toContain("role");
  });
});
