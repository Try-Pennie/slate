// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1760: the manual members picker. The measured defect is a page weight and
// keyboard navigation one before a visual one: /admin/buckets rendered 9,450
// `<input>` elements because roughly 60 bucket forms each drew the whole 136
// person roster as native checkboxes.
//
// The contract that must NOT move is the posted form field: the server action
// still reads `form.getAll("members")` (src/app/admin/actions.ts), so every test
// here asserts on real FormData rather than on which boxes look ticked.

vi.mock("@/app/admin/actions", () => ({
  createBucket: vi.fn(),
  updateBucket: vi.fn(),
}));

import {
  BucketMembersPicker,
  RosterProvider,
} from "@/components/admin/BucketMembersPicker";
import { rosterSectionFor, type RosterEntry } from "@/lib/admin/bucket-member-picker";

const person = (id: string, name: string, role: "agent" | "manager" = "agent"): RosterEntry => ({
  id,
  name,
  email: `${id}@trypennie.com`,
  section: rosterSectionFor(role),
});

const ROSTER: RosterEntry[] = [
  person("ada", "Ada Lovelace"),
  person("alan", "Alan Turing"),
  person("grace", "Grace Hopper", "manager"),
  person("katherine", "Katherine Johnson"),
];

function renderPicker(selectedIds: string[] = []) {
  const view = render(
    <RosterProvider roster={ROSTER}>
      <form data-testid="bucket-form">
        <BucketMembersPicker selectedIds={selectedIds} rosterTotal={ROSTER.length} />
      </form>
    </RosterProvider>,
  );
  const form = () => view.getByTestId("bucket-form") as HTMLFormElement;
  const posted = () => new FormData(form()).getAll("members").map(String);
  return { ...view, form, posted };
}

const openPicker = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /choose members/i }));

describe("BucketMembersPicker posted values", () => {
  it("posts the member ids it was given, with no interaction at all", () => {
    const { posted } = renderPicker(["ada", "grace"]);
    expect(posted().sort()).toEqual(["ada", "grace"]);
  });

  it("posts nothing when the bucket has no manual members", () => {
    const { posted } = renderPicker([]);
    expect(posted()).toEqual([]);
  });

  it("adds a member picked from the roster to the posted values", async () => {
    const user = userEvent.setup();
    const { posted } = renderPicker([]);
    await openPicker(user);
    await user.click(screen.getByRole("option", { name: /Alan Turing/ }));
    expect(posted()).toEqual(["alan"]);
  });

  it("drops a member removed from the selected list", async () => {
    const user = userEvent.setup();
    const { posted } = renderPicker(["ada", "grace"]);
    await user.click(screen.getByRole("button", { name: /remove Ada Lovelace/i }));
    expect(posted()).toEqual(["grace"]);
  });

  it("keeps posting a member the roster does not list, instead of dropping them", () => {
    // The trap #1762 names: a row hidden from the list must not be silently
    // removed by the next save of the form.
    const { posted } = renderPicker(["ada", "someone-off-roster"]);
    expect(posted().sort()).toEqual(["ada", "someone-off-roster"]);
    expect(screen.getByText(/not on the current roster/i)).toBeTruthy();
  });

  it("un-picks a member by activating their already-selected roster row", async () => {
    const user = userEvent.setup();
    const { posted } = renderPicker(["ada"]);
    await openPicker(user);
    const row = screen.getByRole("option", { name: /Ada Lovelace/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
    await user.click(row);
    expect(posted()).toEqual([]);
  });
});

describe("BucketMembersPicker rendered weight", () => {
  it("renders no roster rows until the picker is opened", () => {
    renderPicker(["ada"]);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders no roster checkboxes at all, only one hidden input per member", () => {
    const { form } = renderPicker(["ada", "grace"]);
    expect(form().querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(form().querySelectorAll('input[name="members"]')).toHaveLength(2);
  });

  it("narrows the rendered roster rows to the search matches", async () => {
    const user = userEvent.setup();
    renderPicker([]);
    await openPicker(user);
    expect(screen.getAllByRole("option")).toHaveLength(ROSTER.length);

    await user.type(screen.getByRole("combobox", { name: /search/i }), "hopper");
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Grace Hopper");
  });

  it("says so when the search matches nobody, instead of drawing an empty list", async () => {
    const user = userEvent.setup();
    renderPicker([]);
    await openPicker(user);
    await user.type(screen.getByRole("combobox", { name: /search/i }), "zzz-nobody");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/no one on the roster matches/i)).toBeTruthy();
  });
});

describe("BucketMembersPicker tells its three empty states apart", () => {
  const openWith = async (roster: RosterEntry[] | null) => {
    const user = userEvent.setup();
    const body = (
      <form>
        <BucketMembersPicker selectedIds={[]} rosterTotal={roster?.length ?? 0} />
      </form>
    );
    render(roster === null ? body : <RosterProvider roster={roster}>{body}</RosterProvider>);
    await openPicker(user);
    return user;
  };

  it("says the roster could not be read when there is no provider", async () => {
    await openWith(null);
    // Never the "matches nobody" wording: this panel writes what it shows, so an
    // unreadable roster must not look like an org with nobody in it.
    expect(screen.getByText(/roster could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/no one on the roster matches/i)).toBeNull();
  });

  it("says the org roster is empty when it really is", async () => {
    await openWith([]);
    expect(screen.getByText(/nobody is on the org roster yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("says the search matched nobody when the roster loaded fine", async () => {
    const user = await openWith(ROSTER);
    await user.type(screen.getByRole("combobox", { name: /search/i }), "zzz-nobody");
    expect(screen.getByText(/no one on the roster matches/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

describe("BucketMembersPicker selected members are surfaced separately", () => {
  it("lists the current members above the roster, with a count", () => {
    renderPicker(["ada", "grace"]);
    const chosen = screen.getByRole("group", { name: /in this pool/i });
    expect(within(chosen).getByText(/Ada Lovelace/)).toBeTruthy();
    expect(within(chosen).getByText(/Grace Hopper/)).toBeTruthy();
    expect(screen.getByRole("group", { name: /in this pool \(2\)/i })).toBeTruthy();
  });

  it("says the pool has no manual members rather than showing an empty area", () => {
    renderPicker([]);
    expect(screen.getByText(/no one is added manually/i)).toBeTruthy();
  });

  it("groups the roster into labelled sections so it can be scanned", async () => {
    const user = userEvent.setup();
    renderPicker([]);
    await openPicker(user);
    // Sections are the structure #1762 will hang "departed" / "not bookable" on.
    expect(screen.getByRole("group", { name: /^Agents/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /^Managers/ })).toBeTruthy();
  });
});

describe("BucketMembersPicker keyboard use", () => {
  it("moves an active option with the arrow keys and toggles it with Enter", async () => {
    const user = userEvent.setup();
    const { posted } = renderPicker([]);
    await openPicker(user);
    const search = screen.getByRole("combobox", { name: /search/i });
    expect(document.activeElement).toBe(search);

    await user.keyboard("{ArrowDown}");
    const firstId = search.getAttribute("aria-activedescendant");
    expect(firstId).toBeTruthy();
    expect(document.getElementById(firstId!)!.getAttribute("aria-selected")).toBe("false");

    await user.keyboard("{ArrowDown}");
    const secondId = search.getAttribute("aria-activedescendant");
    expect(secondId).not.toBe(firstId);

    await user.keyboard("{Enter}");
    expect(posted()).toEqual(["alan"]); // Alan Turing, second in the Agents section
    expect(document.getElementById(secondId!)!.getAttribute("aria-selected")).toBe("true");
  });

  it("closes the picker on Escape and returns focus to the disclosure button", async () => {
    const user = userEvent.setup();
    renderPicker([]);
    await openPicker(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /choose members/i }),
    );
  });

  it("never submits the form from inside the picker", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((e: SubmitEvent) => e.preventDefault());
    const { form } = renderPicker([]);
    form().addEventListener("submit", submit as unknown as EventListener);
    await openPicker(user);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("BucketMembersPicker explains what the list is", () => {
  it("says the list is the whole org roster, not the bucket's eligible agents", () => {
    renderPicker([]);
    expect(screen.getByText(/whole org roster/i).textContent).toMatch(/4 people/);
  });
});
