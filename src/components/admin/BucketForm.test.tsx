// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("BucketForm attribute matcher", () => {
  const renderOne = (criteria: Record<string, string[]> = {}) => {
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

  it("posts the criteria it was given, with no interaction at all", () => {
    const { crit } = renderOne({ debt_team: ["high", "mid"] });
    expect(crit("debt_team").sort()).toEqual(["high", "mid"]);
  });

  it("shows the current criteria while collapsed, so a pool can still be scanned", () => {
    renderOne({ debt_team: ["high"], backend: ["beyond"] });
    const summary = screen.getByRole("group", { name: /current routing criteria/i });
    expect(within(summary).getByText("high")).toBeTruthy();
    expect(within(summary).getByText("beyond")).toBeTruthy();
  });

  it("adds a criteria value picked from the opened matcher", async () => {
    const user = userEvent.setup();
    const { crit } = renderOne({});
    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    await user.click(screen.getByRole("checkbox", { name: "ultra_high" }));
    expect(crit("debt_team")).toEqual(["ultra_high"]);
  });

  it("removes a criteria value by switching it back off", async () => {
    const user = userEvent.setup();
    const { crit } = renderOne({ debt_team: ["high"] });
    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    const box = screen.getByRole("checkbox", { name: "high" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    expect(crit("debt_team")).toEqual([]);
  });

  it("keeps posting a stored criteria value the catalog no longer offers, open or closed", async () => {
    // A value no live agent carries any more is absent from the derived catalog,
    // so the matcher draws no control for it. It must still be posted, and it must
    // be posted in BOTH states: dropping it only while the panel happens to be
    // open would make saving destructive depending on what the admin had clicked.
    const user = userEvent.setup();
    const { crit } = renderOne({ debt_team: ["high", "retired_tier"] });
    expect(crit("debt_team").sort()).toEqual(["high", "retired_tier"]);

    await user.click(screen.getByRole("button", { name: /choose routing criteria/i }));
    expect(crit("debt_team").sort()).toEqual(["high", "retired_tier"]);
    expect(screen.getByText(/no longer offered by any agent/i)).toBeTruthy();

    // And it is still there after an unrelated edit inside the open panel.
    await user.click(screen.getByRole("checkbox", { name: "mid" }));
    expect(crit("debt_team").sort()).toEqual(["high", "mid", "retired_tier"]);
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
