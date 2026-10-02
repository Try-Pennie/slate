// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1760. The number in the issue is the whole point: /admin/buckets served 9,450
// `<input>` elements and 127 `<select>` elements on ONE page, because each of ~60
// bucket forms rendered the whole 136 person roster as checkboxes plus the
// attribute matcher's checkbox grid. At the 200 agent design target that is about
// 14,000 controls.
//
// So the assertion that matters is not "it looks better", it is that the control
// count STOPS SCALING with buckets times roster. That is measured here by
// rendering the same page shape at two roster sizes and requiring the count not to
// move, which a purely visual restyle could not pass.

vi.mock("@/app/admin/actions", () => ({
  createBucket: vi.fn(),
  updateBucket: vi.fn(),
}));

import { BucketForm } from "@/components/admin/BucketForm";
import { RosterProvider } from "@/components/admin/BucketMembersPicker";
import { rosterSectionFor, type RosterEntry } from "@/lib/admin/bucket-member-picker";
import type { Bucket, EventType } from "@/lib/db/types";

const EVENT_TYPES = [{ id: "et1", name: "Review call" }] as unknown as EventType[];

const CATALOG: Record<string, string[]> = {
  debt_team: ["ultra_high", "high", "mid", "low"],
  backend: ["beyond", "clearone", "national"],
};

function roster(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    name: `Agent ${String(i).padStart(3, "0")}`,
    email: `u${i}@trypennie.com`,
    section: rosterSectionFor(i === 0 ? "manager" : "agent"),
  }));
}

function bucket(i: number, criteria: Record<string, string[]> = {}): Bucket {
  return {
    id: `b${i}`,
    org_id: "o1",
    code: `${400 + i}`,
    name: `Bucket ${i}`,
    event_type_id: "et1",
    criteria,
    routing_form_id: null,
    fallback_user_id: null,
  } as unknown as Bucket;
}

/** The whole /admin/buckets bucket list, at a given roster and bucket count. */
function renderPage(bucketCount: number, rosterSize: number, membersPerBucket = 0) {
  const people = roster(rosterSize);
  const memberIds = new Set(people.slice(0, membersPerBucket).map((p) => p.id));
  return render(
    <RosterProvider roster={people}>
      <div data-testid="page">
        {Array.from({ length: bucketCount }, (_, i) => (
          <BucketForm
            key={i}
            bucket={bucket(i)}
            eventTypes={EVENT_TYPES}
            roster={people}
            memberIds={memberIds}
            catalog={CATALOG}
            eligibleCount={3}
          />
        ))}
      </div>
    </RosterProvider>,
  );
}

const countControls = (root: HTMLElement) => ({
  inputs: root.querySelectorAll("input").length,
  selects: root.querySelectorAll("select").length,
  focusable: root.querySelectorAll("input, select, button, [tabindex]:not([tabindex='-1'])").length,
});

describe("BucketForm rendered control count", () => {
  it("does not scale the control count with the roster size", () => {
    const small = renderPage(60, 136);
    const a = countControls(small.getByTestId("page"));
    small.unmount();

    const large = renderPage(60, 272);
    const b = countControls(large.getByTestId("page"));
    large.unmount();

    expect(b.inputs).toBe(a.inputs);
    expect(b.selects).toBe(a.selects);
    expect(b.focusable).toBe(a.focusable);
  });

  // #1784: the OPTION count is the half #1760 left behind. The fallback agent
  // control was a <select> per form listing the whole roster, so the served page
  // still carried 8,755 <option> elements, about 70% of its nodes, scaling with
  // buckets times roster exactly as the checkboxes had.
  it("does not scale the OPTION count with the roster size either", () => {
    const small = renderPage(60, 136);
    const a = small.getByTestId("page").querySelectorAll("option").length;
    small.unmount();

    const large = renderPage(60, 272);
    const b = large.getByTestId("page").querySelectorAll("option").length;
    large.unmount();

    expect(b).toBe(a);
  });

  it("stays far under the 8,755 options the served page measured", () => {
    const view = renderPage(60, 136);
    const options = view.getByTestId("page").querySelectorAll("option").length;
    // 60 forms times a handful of real choices, not 60 times the roster.
    expect(options).toBeLessThan(60 * 20);
  });

  it("stays far under the 9,450 inputs the served page measured", () => {
    const view = renderPage(60, 136);
    const { inputs } = countControls(view.getByTestId("page"));
    // 60 forms times the handful of real fields, not 60 times the roster.
    expect(inputs).toBeLessThan(60 * 8);
  });

  it("carries exactly one hidden members input per actual membership", () => {
    const view = renderPage(60, 136, 2);
    const page = view.getByTestId("page");
    expect(page.querySelectorAll('input[name="members"]')).toHaveLength(60 * 2);
    expect(page.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("renders no attribute matcher options until a matcher is opened", () => {
    const view = renderPage(60, 136);
    // The catalog holds 7 values; 60 forms rendering them all is 420 controls.
    expect(within(view.getByTestId("page")).queryAllByRole("checkbox")).toHaveLength(0);
  });
});

// #1935: THE MATCHER BELONGS TO THE CREATE FORM NOW.
//
// The seeder rewrites a bucket's criteria from `src/lib/xbc.ts` on every run, so
// editing them on an existing bucket wrote a value the next seed run replaced.
// The picker is offered where the choice is real, which is when a bucket is
// being created, and everything here exercises it there.
//
// The tests that DEFENDED the old edit behaviour are gone rather than adjusted,
// because their whole content was the behaviour being removed (L252): posting a
// stored value back, and carrying an orphaned one through a save. On an existing
// bucket nothing is posted at all now, and that is asserted below rather than
// left to be inferred from their absence.
describe("BucketForm attribute matcher, creating a bucket", () => {
  const renderNew = () => {
    const people = roster(4);
    const view = render(
      <RosterProvider roster={people}>
        <BucketForm
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={0}
        />
      </RosterProvider>,
    );
    const form = () => view.container.querySelector("form") as HTMLFormElement;
    const crit = (key: string) => new FormData(form()).getAll(`crit_${key}`).map(String);
    return { ...view, form, crit };
  };

  it("starts with nothing chosen, and says so rather than drawing an empty group", () => {
    const { crit } = renderNew();
    expect(crit("debt_team")).toEqual([]);
    expect(screen.getByText(/no attribute criteria/i)).toBeTruthy();
  });

  it("adds a criteria value picked from the opened matcher", async () => {
    const user = userEvent.setup();
    const { crit } = renderNew();
    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    await user.click(screen.getByRole("checkbox", { name: "ultra_high" }));
    expect(crit("debt_team")).toEqual(["ultra_high"]);
  });

  it("removes a criteria value by switching it back off", async () => {
    const user = userEvent.setup();
    const { crit } = renderNew();
    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    const box = screen.getByRole("checkbox", { name: "high" }) as HTMLInputElement;
    await user.click(box);
    expect(crit("debt_team")).toEqual(["high"]);
    await user.click(box);
    expect(crit("debt_team")).toEqual([]);
  });

  it("keeps a chosen value while the panel is closed again", async () => {
    // Closing the panel unmounts every control in it, so the value has to
    // survive as a hidden input or a save made with it shut would post nothing.
    const user = userEvent.setup();
    const { crit } = renderNew();
    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    await user.click(screen.getByRole("checkbox", { name: "high" }));
    await user.click(screen.getByRole("button", { name: /done choosing criteria/i }));
    expect(crit("debt_team")).toEqual(["high"]);
  });
});

// The read only state, which is what an EXISTING bucket draws.
describe("BucketForm attribute matcher, editing a bucket (#1935)", () => {
  const renderEdit = (criteria: Record<string, string[]> = {}) => {
    const people = roster(4);
    const view = render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={{ ...bucket(1), criteria }}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={3}
        />
      </RosterProvider>,
    );
    const form = () => view.container.querySelector("form") as HTMLFormElement;
    const crit = (key: string) => new FormData(form()).getAll(`crit_${key}`).map(String);
    return { ...view, form, crit };
  };

  it("still shows what the pool routes by, which is what somebody came to read", () => {
    renderEdit({ debt_team: ["high"], backend: ["beyond"] });
    const summary = screen.getByRole("group", { name: /current routing criteria/i });
    expect(within(summary).getByText("high")).toBeTruthy();
    expect(within(summary).getByText("beyond")).toBeTruthy();
  });

  it("offers no way to change them, and says why", () => {
    renderEdit({ debt_team: ["high"] });
    expect(screen.queryByRole("button", { name: /choose routing criteria/i })).toBeNull();
    expect(screen.queryAllByRole("checkbox", { name: "high" })).toHaveLength(0);
    expect(screen.getByText(/replaced the next time the seeder runs/i)).toBeTruthy();
  });

  it("posts no criteria at all, because nothing reads them", () => {
    // `updateBucket` takes the criteria from the stored row and ignores the form,
    // so posting them would be writing a value nothing reads and would leave the
    // next reader working out which of the two was authoritative.
    const { crit } = renderEdit({ debt_team: ["high", "retired_tier"] });
    expect(crit("debt_team")).toEqual([]);
  });

  it("says when no agent attributes have synced, rather than drawing an empty matcher", () => {
    const people = roster(2);
    render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={bucket(2)}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={{}}
          eligibleCount={0}
        />
      </RosterProvider>,
    );
    expect(screen.getByText(/no agent attributes synced yet/i)).toBeTruthy();
  });

  it("shows the code and the name without offering them for typing", () => {
    renderEdit({});
    const form = document.querySelector("form") as HTMLFormElement;
    expect(form.querySelector('input[name="code"]')).toBeNull();
    expect(form.querySelector('input[name="name"]')).toBeNull();
    // But they are still on screen: read only is not hidden.
    expect(screen.getByText(bucket(1).code)).toBeTruthy();
  });
});

// #2006: WHICH bucket is frozen, and it is not "every existing one".
//
// The seeder rewrites a bucket's code, name and criteria from `xbc.ts` on every
// run, but it writes only the sixty XBC codes. #1935 froze every existing
// bucket, which took the hand created ones with it: their fields are set nowhere
// but the create form, so a typo in one was permanent (L615).
describe("BucketForm freezes only what the seeder writes (#2006)", () => {
  const renderOne = (code: string) => {
    const people = roster(3);
    return render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={{ ...bucket(1), code, name: "Typed by hand" } as Bucket}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={1}
        />
      </RosterProvider>,
    );
  };

  it("leaves a hand created bucket's code and name editable", () => {
    const { container } = renderOne("SMOKE");
    const form = container.querySelector("form") as HTMLFormElement;
    // Editable, AND holding what is stored: a box that came up blank would lose
    // the name on the next save, which is worse than not offering it at all.
    const code = form.querySelector('input[name="code"]') as HTMLInputElement;
    const name = form.querySelector('input[name="name"]') as HTMLInputElement;
    expect(code?.value).toBe("SMOKE");
    expect(name?.value).toBe("Typed by hand");
    // And its routing criteria can be changed too, for the same reason.
    expect(screen.getByRole("button", { name: /choose routing criteria/i })).toBeTruthy();
  });

  it("still freezes one the seeder writes", () => {
    const { container } = renderOne("411");
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.querySelector('input[name="code"]')).toBeNull();
    expect(form.querySelector('input[name="name"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /choose routing criteria/i })).toBeNull();
    expect(screen.getByText(/replaced the next time the seeder runs/i)).toBeTruthy();
  });

  // The boundary itself, so neither test above is passing on one lucky code.
  it("draws the line at the matrix, not at the shape of the code", () => {
    const { container: inside } = renderOne("100");
    expect(inside.querySelector('input[name="code"]')).toBeNull();
    cleanup();
    const { container: outside } = renderOne("999");
    expect(outside.querySelector('input[name="code"]')).toBeTruthy();
  });
});

describe("BucketForm explains its two counts", () => {
  it("says what the eligible count measures and what the manual list offers", () => {
    const people = roster(136);
    render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={bucket(3)}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={12}
        />
      </RosterProvider>,
    );
    expect(screen.getByText(/12 eligible agents/)).toBeTruthy();
    const note = screen.getByTestId("bucket-count-note").textContent ?? "";
    expect(note).toMatch(/bookable/i);
    expect(note).toMatch(/attributes match/i);
    expect(note).toMatch(/manual members/i);
    // Both numbers are correct; the note exists so the gap is not read as a bug.
    expect(note).toMatch(/differ|different/i);
    // And the roster figure itself is stated on the list it describes.
    expect(screen.getByText(/whole org roster/i).textContent).toMatch(/136 people/);
  });

  it("keeps the no-fallback warning on a bucket nobody is eligible for", () => {
    const people = roster(3);
    render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={bucket(4)}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={0}
        />
      </RosterProvider>,
    );
    expect(screen.getByText(/no fallback set, bookings will fail/i)).toBeTruthy();
  });
});

// #1849: the event type control is a picker of our own now, and two things about
// it changed that no other test here would notice.
//
// The native element had `required`. A hidden input is NOT validated by the
// browser, so that attribute is gone; it is not missed HERE because every option
// carries a real event type id and there was no empty value it could ever have
// refused. What replaces it is this: the control always has a real value.
//
// The native element also picked the first option on its own when nothing was
// selected. A picker does not, so the fallback is written down, and these assert
// it rather than leaving the form able to post an empty event type.
describe("the event type picker always carries a real value (#1849)", () => {
  const TYPES = [
    { id: "et1", name: "Review call" },
    { id: "et2", name: "Follow up" },
  ] as unknown as EventType[];

  function form(b: Bucket | undefined) {
    return render(
      <RosterProvider roster={roster(3)}>
        <BucketForm
          bucket={b}
          eventTypes={TYPES}
          roster={roster(3)}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={3}
        />
      </RosterProvider>,
    );
  }
  const posted = (c: HTMLElement) =>
    (c.querySelector('input[name="event_type_id"]') as HTMLInputElement | null)?.value;

  it("posts the bucket's own event type when it has one", () => {
    const { container } = form({ ...bucket(1), event_type_id: "et2" } as Bucket);
    expect(posted(container)).toBe("et2");
    expect(screen.getByRole("combobox", { name: "Event type" }).textContent).toContain("Follow up");
  });

  it("falls back to the first available type on a NEW bucket, rather than posting nothing", () => {
    // A new bucket has no event type, and the form has no empty option to offer.
    // Without the fallback this posted "" and the server took a bucket with no
    // event type, which is the state `required` used to prevent.
    const { container } = form(undefined);
    expect(posted(container)).toBe("et1");
    expect(screen.getByRole("combobox", { name: "Event type" }).textContent).toContain("Review call");
  });

  it("posts what was chosen after a change", async () => {
    const user = userEvent.setup();
    const { container } = form(undefined);
    await user.click(screen.getByRole("combobox", { name: "Event type" }));
    await user.click(screen.getByRole("option", { name: "Follow up" }));
    expect(posted(container)).toBe("et2");
  });
});

// #1929. Two working buckets rendered "0 eligible agents (no fallback set,
// bookings will fail)" in the error colour on every view of /admin/buckets,
// measured live on 2026-09-04: five red rows, three of them real.
//
// The cause was two reads disagreeing about what counts. `bucketDepthByCode`
// excludes test buckets and the page's bucket read did not, so the SMOKE buckets
// arrived with no depth entry, and `?? 0` at the call site turned "excluded from
// the measurement" into "measured zero", which is the one state this panel paints
// as a failure.
describe("the eligible count has three states, and only one is a failure (#1929)", () => {
  const draw = (eligibleCount: number | undefined, fallback: string | null = null) => {
    const people = roster(3);
    return render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={{ ...bucket(1), fallback_user_id: fallback }}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={eligibleCount}
        />
      </RosterProvider>,
    );
  };

  it("says a count was not measured rather than calling it zero", () => {
    draw(undefined);
    const line = screen.getByText("Eligible agents not measured");
    // The claim it must never make from a reading that never happened. Scoped to
    // the count line, because the members picker's own collapsed summary says
    // "0 selected" and would answer a document wide search for a zero.
    expect(line.textContent).not.toMatch(/bookings will fail/i);
    expect(line.textContent).not.toMatch(/\d+ eligible agent/);
  });

  it("does not paint an unmeasured count in the error colour", () => {
    draw(undefined);
    const line = screen.getByText("Eligible agents not measured");
    // Colour is the only thing that separates this panel's three states at a
    // glance, so an unmeasured count wearing the error colour IS the false alarm.
    expect(line.className).not.toMatch(/error/);
  });

  it("still calls a MEASURED zero with no fallback a failure, in the error colour", () => {
    draw(0);
    const line = screen.getByText(/no fallback set, bookings will fail/);
    expect(line.className).toMatch(/error/);
  });

  // Dan, 2026-10-02: a pool nobody matches is not failing when the routing
  // ladder carries its leads to a staffed pool.
  it("names where leads go when nobody matches and the ladder reaches a staffed pool", () => {
    const people = roster(3);
    render(
      <RosterProvider roster={people}>
        <BucketForm
          bucket={bucket(1)}
          eventTypes={EVENT_TYPES}
          roster={people}
          memberIds={new Set()}
          catalog={CATALOG}
          eligibleCount={0}
          overflowTo="Low with Achieve"
        />
      </RosterProvider>,
    );
    const line = screen.getByText(/0 eligible agents/);
    expect(line.textContent).toMatch(/leads go to Low with Achieve/);
    expect(line.textContent).not.toMatch(/bookings will fail/i);
    expect(line.className).not.toMatch(/error/);
  });

  it("treats a measured zero with a fallback as working, not as a failure", () => {
    draw(0, "u9");
    const line = screen.getByText(/using fallback agent/);
    expect(line.className).not.toMatch(/error/);
    expect(line.textContent).not.toMatch(/bookings will fail/i);
  });

  it("reads a real count in the singular and the plural", () => {
    draw(1);
    expect(screen.getByText("1 eligible agent")).toBeTruthy();
    cleanup();
    draw(4);
    expect(screen.getByText("4 eligible agents")).toBeTruthy();
  });
});
