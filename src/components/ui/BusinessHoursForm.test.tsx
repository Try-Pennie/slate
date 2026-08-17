// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// #1297: the business-hours editor's rendered surface.
//
// The assertions worth having here are all about copy that must not blur two
// different situations together, because the whole point of this panel is to be a
// number someone acts on:
//
//  * COULD NOT CHECK vs A REAL ZERO. The roster read throws rather than returning
//    empty. An unreadable roster rendered as "nobody covers this" reads as a staffing
//    problem, and someone would go and fix a roster that was fine.
//  * A WARNING vs AN ERROR. Closing a day that already holds appointments is allowed;
//    the person is shown the consequence once and confirms. Rendering that as an
//    error would say something had gone wrong when nothing had.
vi.mock("@/components/ui/TimeField", () => ({
  TimeField: ({ name, ariaLabel }: { name: string; ariaLabel: string }) => (
    <input aria-label={ariaLabel} name={name} />
  ),
}));
vi.mock("@/components/ui/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

const actionState = vi.hoisted(() => ({ current: { error: null } as Record<string, unknown> }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: () => [actionState.current, vi.fn(), false],
  };
});

import { BusinessHoursForm, type BusinessHoursDay } from "./BusinessHoursForm";
import type { CoverageReadout } from "@/lib/booking/business-hours-coverage";

const DAYS: BusinessHoursDay[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  is_open: weekday !== 7,
  start: "08:00",
  end: "20:00",
}));

const draw = (coverage: CoverageReadout, state: Record<string, unknown> = { error: null }) => {
  actionState.current = state;
  return render(
    <BusinessHoursForm
      action={vi.fn()}
      days={DAYS}
      zoneLabel="New York"
      coverage={coverage}
    />,
  );
};

const openDay = (weekday: number, hours: { hour: number; agents: number }[]) => ({
  weekday,
  is_open: true,
  hours,
});

describe("BusinessHoursForm", () => {
  it("renders every weekday, with the closed one unchecked", () => {
    draw({ ok: false });
    for (const name of ["Monday", "Saturday", "Sunday"]) {
      expect(screen.getByRole("checkbox", { name })).toBeTruthy();
    }
    expect((screen.getByRole("checkbox", { name: "Monday" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Sunday" }) as HTMLInputElement).checked).toBe(false);
    // Both ends of every day are individually labelled, so a screen reader user is
    // never left guessing which of fourteen time controls they are on.
    expect(screen.getByLabelText("Wednesday opening time")).toBeTruthy();
    expect(screen.getByLabelText("Wednesday closing time")).toBeTruthy();
  });

  describe("the coverage panel", () => {
    it("says it could not check, and never that nobody is available", () => {
      draw({ ok: false });
      expect(screen.getByText(/could not be checked/i)).toBeTruthy();
      // The distinction with teeth: an unreadable roster must not read as a
      // staffing gap someone would then go and 'fix'.
      expect(screen.queryByText(/nobody is rostered/i)).toBeNull();
      expect(screen.queryByText(/every open hour has someone/i)).toBeNull();
      expect(screen.getByText(/not saying nobody is/i)).toBeTruthy();
    });

    it("reports a measured zero as a measured zero", () => {
      draw({ ok: true, bookableAgents: 0, days: [], uncoveredHours: 0 });
      expect(screen.getByText(/No agents are in the booking pool/i)).toBeTruthy();
      // And it explains WHY that is currently expected, so nobody treats the
      // deliberate pool-off state as a fault (#1272).
      expect(screen.getByText(/pool is switched off/i)).toBeTruthy();
      expect(screen.queryByText(/could not be checked/i)).toBeNull();
    });

    it("names the open hours nobody is rostered for", () => {
      draw({
        ok: true,
        bookableAgents: 4,
        uncoveredHours: 4,
        days: [
          openDay(1, [
            { hour: 8, agents: 0 },
            { hour: 9, agents: 2 },
            { hour: 17, agents: 0 },
            { hour: 18, agents: 0 },
            { hour: 19, agents: 0 },
          ]),
        ],
      });
      expect(screen.getByText(/4 agents are in the booking pool/i)).toBeTruthy();
      // #1458: the SAME grouping and phrasing the roster alarm posts to Slack, so
      // an admin reading this screen and reading the page cannot meet two
      // spellings of one finding. Consecutive uncovered hours still collapse into
      // a range; each line now names its day, which is what lets identical
      // weekday gaps be stated once.
      expect(screen.getByText("08:00 to 09:00 Monday")).toBeTruthy();
      expect(screen.getByText("17:00 to 20:00 Monday")).toBeTruthy();
    });

    it("says so plainly when every open hour is covered", () => {
      draw({
        ok: true,
        bookableAgents: 2,
        uncoveredHours: 0,
        days: [openDay(1, [{ hour: 9, agents: 2 }])],
      });
      expect(screen.getByText(/Every open hour has someone rostered/i)).toBeTruthy();
    });

    it("does not list a closed day as a coverage gap", () => {
      draw({
        ok: true,
        bookableAgents: 2,
        uncoveredHours: 0,
        days: [openDay(1, [{ hour: 9, agents: 2 }]), { weekday: 7, is_open: false, hours: [] }],
      });
      expect(screen.queryByText(/Sunday/, { selector: "li *" })).toBeNull();
    });
  });

  describe("the confirmation step", () => {
    it("shows the warning without dressing it as an error", () => {
      draw(
        { ok: false },
        { error: null, confirm: { message: "Closing Monday leaves 3 appointments already booked." } },
      );
      expect(screen.getByText(/3 appointments already booked/)).toBeTruthy();
      // The submit says what the second press will do, so confirming is deliberate.
      expect(screen.getByRole("button", { name: /save anyway/i })).toBeTruthy();
      // And the flag rides on the NEXT submit rather than being pre-ticked for them.
      const flag = document.querySelector('input[name="confirm_close"]') as HTMLInputElement;
      expect(flag?.value).toBe("1");
      expect(flag?.type).toBe("hidden");
    });

    it("carries no confirm flag on an ordinary first render", () => {
      draw({ ok: false });
      expect(document.querySelector('input[name="confirm_close"]')).toBeNull();
      expect(screen.getByRole("button", { name: /save business hours/i })).toBeTruthy();
    });

    it("renders a refusal as an alert the assistive tech announces", () => {
      draw({ ok: false }, { error: "Wednesday: enter an opening time, or close the day." });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/Wednesday/);
    });
  });
  // #1458: the other half of the wiring. The action produces the warning
  // (src/app/admin/set-business-hours.test.ts); this is the only thing that can
  // say it reaches the screen, and that the ordinary saved notice gets out of its
  // way rather than the admin meeting two success lines at once.
  describe("the coverage warning after a save", () => {
    const WARNING =
      "Saved. These hours are now open with no bookable agent rostered: " +
      "17:00 to 20:00 Monday to Friday. A lead asking for one of those times is " +
      "offered nothing and is not told why. Set agents' working hours to cover " +
      "them, or narrow the business hours again.";

    it("shows the warning the save came back with, announced as a status", () => {
      draw({ ok: false }, { error: null, ok: true, warning: WARNING });

      // Exactly one, so the ordinary saved notice steps aside rather than the
      // admin meeting "Saved." twice, once of which mentions the gap.
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("17:00 to 20:00 Monday to Friday");
      // It leads with the save having gone through. A warning, never a refusal.
      expect(status.textContent).toMatch(/^\s*Coverage\s*Saved\./);
      // And it is NOT an error: nothing went wrong, so nothing may be announced
      // as though something did.
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("carries a second signal besides colour", () => {
      draw({ ok: false }, { error: null, ok: true, warning: WARNING });
      expect(screen.getByText("Coverage")).toBeTruthy();
    });

    it("shows the plain saved notice instead when nothing was opened uncovered", () => {
      draw({ ok: false }, { error: null, ok: true, warning: null });

      const statuses = screen.getAllByRole("status");
      expect(statuses).toHaveLength(1);
      expect(statuses[0].textContent).not.toMatch(/no bookable agent rostered/);
      expect(screen.queryByText("Coverage")).toBeNull();
    });
  });
});
