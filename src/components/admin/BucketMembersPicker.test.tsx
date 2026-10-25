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
  BucketCriteriaPicker,
  BucketMembersPicker,
  RosterProvider,
} from "@/components/admin/BucketMembersPicker";
import { rosterSectionFor, type RosterEntry } from "@/lib/admin/bucket-member-picker";
import { labelInNameMismatches } from "@/components/ui/label-in-name.test-support";

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

// #1784: the same picker in single select mode, standing in for the fallback
// agent `<select>` that listed the whole roster in every bucket form. What has to
// hold is the posted field (the server action reads `fallback_user_id` and
// treats an empty string as "no fallback"), and that ONE person can be chosen: a
// second `fallback_user_id` value would make the posted field ambiguous.
describe("BucketMembersPicker in fallback mode (#1784)", () => {
  function renderFallback(selectedIds: string[] = [], roster: RosterEntry[] = ROSTER) {
    const view = render(
      <RosterProvider roster={roster}>
        <form data-testid="bucket-form">
          <BucketMembersPicker
            mode="fallback"
            selectedIds={selectedIds}
            rosterTotal={roster.length}
          />
        </form>
      </RosterProvider>,
    );
    const form = () => view.getByTestId("bucket-form") as HTMLFormElement;
    return {
      ...view,
      form,
      /** Every value posted under the field, so a second one is visible. */
      all: () => new FormData(form()).getAll("fallback_user_id").map(String),
      posted: () => String(new FormData(form()).get("fallback_user_id") ?? "\u0000missing"),
    };
  }

  const open = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /choose a fallback agent/i }));

  it("posts the field EMPTY rather than absent when no fallback is set", async () => {
    const { posted, all } = renderFallback();
    // Absent would read as "leave it alone"; the select it replaces always posted
    // the field, and an admin clearing a fallback has to be able to clear it.
    expect(posted()).toBe("");
    expect(all()).toEqual([""]);
  });

  it("posts the stored fallback, and renders no roster options until it is opened", () => {
    const { posted, container } = renderFallback(["alan"]);
    expect(posted()).toBe("alan");
    // The whole point of the change: no <option> per person, per bucket.
    expect(container.querySelectorAll("option")).toHaveLength(0);
    expect(screen.getByText("Alan Turing")).toBeTruthy();
  });

  it("REPLACES the choice rather than adding a second one", async () => {
    const user = userEvent.setup();
    const { posted, all } = renderFallback(["alan"]);

    await open(user);
    await user.click(screen.getByRole("option", { name: /ada lovelace/i }));

    expect(posted()).toBe("ada");
    // Two values under one field is the failure this mode exists to prevent.
    expect(all()).toEqual(["ada"]);
  });

  it("clears the fallback when the person already set is chosen again", async () => {
    const user = userEvent.setup();
    const { posted } = renderFallback(["alan"]);

    await open(user);
    await user.click(screen.getByRole("option", { name: /alan turing/i }));

    expect(posted()).toBe("");
  });

  it("clears the fallback from the chip, and says that is what it does", async () => {
    const user = userEvent.setup();
    const { posted } = renderFallback(["alan"]);

    await user.click(screen.getByRole("button", { name: /clear alan turing as the fallback agent/i }));
    expect(posted()).toBe("");
  });

  it("keeps a stored fallback the roster does not list, rather than dropping it on save", () => {
    const { posted } = renderFallback(["departed-id"]);
    // The #1762 trap: a fallback the page cannot show must not be removed by a
    // save that was about something else.
    expect(posted()).toBe("departed-id");
    expect(screen.getByText(/not on the current roster/i)).toBeTruthy();
  });

  it("does not tell assistive tech that several can be chosen", async () => {
    const user = userEvent.setup();
    renderFallback();
    await open(user);
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBeNull();
  });

  // Dan, 2026-10-02: no fallback does not mean bookings fail, because the
  // routing ladder carries a lead nobody matches to the next staffed pool.
  it("says what happens with no fallback: the ladder, and failure only at its end", () => {
    renderFallback();
    const line = screen.getByText(/No fallback set/);
    expect(line.textContent).toMatch(/routing ladder/);
    expect(line.textContent).toMatch(/outside the ladder, or one whose ladder reaches nobody, fails them/);
  });

  it("tells an unreadable roster apart from an empty one", async () => {
    const user = userEvent.setup();
    // An unreadable roster is the ABSENCE of the provider, which is how the page
    // expresses a read that threw rather than a read that came back empty.
    render(
      <form>
        <BucketMembersPicker mode="fallback" selectedIds={[]} rosterTotal={0} />
      </form>,
    );
    await open(user);
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/nobody is on the org roster/i)).toBeNull();
  });
});

// #1896: TEXT ON A CHIP MAY NOT USE THE PAGE'S MUTED TOKEN.
//
// `--fg-muted` is calibrated against the page background. A chip paints its own
// background, so a muted foreground inside one is half of a pair whose other
// half was swapped, which is the defect L213 names: both tokens are real, the
// call site reads as correct, and the result is text that is present in the DOM,
// correctly announced, and too faint to read.
//
// It is not hypothetical. Measured with axe on the real page on 2026-09-06, the
// attribute name on a routing criteria chip came to 3.9:1 against the chip's own
// `#454349` in dark theme, under the 4.5:1 body text needs. It had been there
// since the chips were built and was invisible because the editor it sits in was
// one of sixty stacked forms nobody scrolled to.
//
// jsdom computes no colours, so what a test here can assert is the COMPOSITION
// rather than the ratio: that no descendant of a chip carries the page level
// muted token. The ratio itself is measured with axe against the running page,
// and the number above is the record of that reading (L63: this is a proxy, and
// saying so is the point).
describe("chips never carry the page's muted foreground (#1896)", () => {
  const chipOf = (el: HTMLElement): HTMLElement[] =>
    [...el.querySelectorAll<HTMLElement>(".rounded-xs")];

  /**
   * Muted descendants that are actually TEXT.
   *
   * An `aria-hidden` glyph is exempt, and deliberately: it is a decorative mark
   * rather than words, so it is judged as a graphical object at 3:1 rather than
   * as body text at 4.5:1, and the measured 3.9:1 clears that. The remove
   * affordance is the whole chip, not the cross, so nothing depends on reading
   * the glyph itself.
   */
  const mutedText = (chip: HTMLElement): Element[] =>
    [...chip.querySelectorAll(".text-fg-muted")].filter(
      (n) => n.getAttribute("aria-hidden") !== "true",
    );

  it("draws a criteria chip with no muted descendant", () => {
    const { container } = render(
      <BucketCriteriaPicker
        catalog={{ debt_team: ["low", "medium"], backend_service: ["beyond"] }}
        current={{ debt_team: "low", backend_service: "beyond" }}
      />,
    );
    const chips = chipOf(container);
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(mutedText(chip)).toHaveLength(0);
      // A positive control on the assertion itself: the chip really does hold
      // the text this is about, so an empty chip could not satisfy it.
      expect(chip.textContent).toMatch(/debt_team|backend_service/);
    }
  });

  it("draws a selected member chip with no muted descendant", () => {
    const roster = [person("u1", "Ada Byron")];
    const { container } = render(
      <RosterProvider roster={roster}>
        <BucketMembersPicker selectedIds={["u1", "ghost"]} rosterTotal={roster.length} />
      </RosterProvider>,
    );
    const chips = chipOf(container);
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(mutedText(chip)).toHaveLength(0);
    }
    // The membership whose user is off the roster is one of them, and its
    // explanatory aside is exactly the text that was muted (#1762).
    expect(screen.getByText(/not on the current roster/)).toBeTruthy();
  });
});

// #3917 (L786): each chip is a button whose name is set apart from its text, so the
// name must contain every word the chip shows, the off roster note included, or a
// person driving by voice cannot say what they see.
describe("member chips are named with the words they show", () => {
  it("in members mode, for a listed member and one off the roster", () => {
    const { container } = renderPicker(["ada", "someone-off-roster"]);
    expect(screen.getByText(/not on the current roster/i)).toBeTruthy();
    expect(labelInNameMismatches(container)).toEqual([]);
  });

  it("in fallback mode, for a fallback the roster does not list", () => {
    const { container } = render(
      <RosterProvider roster={ROSTER}>
        <BucketMembersPicker mode="fallback" selectedIds={["departed-id"]} rosterTotal={ROSTER.length} />
      </RosterProvider>,
    );
    expect(screen.getByText(/not on the current roster/i)).toBeTruthy();
    expect(labelInNameMismatches(container)).toEqual([]);
  });
});
