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
  totalRoster: ROWS.length,
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
    await userEvent.selectOptions(screen.getByLabelText(/Filter by role/i), "agent");

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

    expect(screen.getByText(/Nobody on the roster matches those filters/i)).toBeTruthy();
  });

  it("distinguishes an empty roster from a filter that matched nothing", () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={[]} totalRoster={0} />);

    // Different causes, different sentences: "no agents yet" and "your filter
    // matched nobody" send you to different places.
    expect(screen.getByText(/No agents yet/i)).toBeTruthy();
    expect(screen.queryByText(/matches those filters/i)).toBeNull();
  });

  it("clears every filter at once", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "ada");
    await userEvent.selectOptions(screen.getByLabelText(/Filter by bookable/i), "yes");
    expect(bodyRows()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /clear/i }));

    expect(bodyRows()).toHaveLength(3);
  });

  it("pages in the browser, with no navigation", async () => {
    const many = Array.from({ length: ROSTER_PAGE_SIZE + 5 }, (_, i) =>
      row(`u${i}`, `Person ${String(i).padStart(3, "0")}`),
    );
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={many} totalRoster={many.length} />);
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
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} rows={many} totalRoster={many.length} />);
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));

    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "Person 0");

    // Otherwise a narrower filter leaves you on page 2 of a one page list, which
    // renders as an empty table over a filter that matched plenty.
    expect(bodyRows().length).toBeGreaterThan(0);
  });

  it("counts what is shown against what was matched and what exists", async () => {
    render(<RosterTable {...base} roleOptions={[...base.roleOptions]} />);
    await userEvent.type(screen.getByLabelText(/Search by name or email/i), "a");

    // The readout is the only thing that says a filter is hiding people, so it
    // has to name both numbers.
    expect(screen.getByText(/of 3/)).toBeTruthy();
  });
});
