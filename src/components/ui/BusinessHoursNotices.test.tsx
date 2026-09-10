// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BusinessHoursExceptions } from "@/components/ui/BusinessHoursExceptions";
import { BusinessHoursForm } from "@/components/ui/BusinessHoursForm";
import {
  HOURS_SAVED_MESSAGE,
  exceptionSavedMessage,
} from "@/lib/booking/business-hours-copy";
import type { BusinessHoursFormState } from "@/app/admin/actions";

// #2219: the sentence a save draws, on the screen that draws it.
//
// The builders are pinned offline by scripts/test-business-hours-copy.ts. What
// no static scan can see is whether the COMPONENT renders them, so this mounts
// both panels and asserts the builder's exact output is on screen. Without it a
// component could go back to holding its own inline sentence while the builder
// sat there rendering correctly for a test, which is worse than no builder
// because it would be believed (the same reason copy-preview-parity.test.tsx
// exists for the booker).
vi.mock("@/components/ui/TimeField", () => ({
  TimeField: ({ name, ariaLabel }: { name: string; ariaLabel: string }) => (
    <input aria-label={ariaLabel} name={name} />
  ),
}));

/**
 * The outcome `useActionState` hands the panel. React is mocked rather than the
 * action driven for real, because what is under test is the RENDER of a given
 * outcome, and a real submit would have to reach the server action to produce
 * one.
 */
const outcome = vi.hoisted(() => ({ current: { error: null } as unknown }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useActionState: () => [outcome.current, vi.fn(), false] };
});

function withState(state: BusinessHoursFormState) {
  outcome.current = state;
}

describe("the date exception notice", () => {
  it("says the date is CLOSED, and never that leads see it", () => {
    withState({ error: null, ok: true, saved: { onDate: "2027-01-01", isOpen: false } });
    render(
      <BusinessHoursExceptions
        action={vi.fn()}
        removeAction={vi.fn()}
        exceptions={[]}
        zoneLabel="Eastern"
      />,
    );
    const want = exceptionSavedMessage({ onDate: "2027-01-01", isOpen: false });
    expect(screen.getByRole("status").textContent).toBe(want);
    expect(screen.queryByText(/Leads see that date straight away/)).toBeNull();
  });

  it("says the date is OPEN when that is what was saved", () => {
    withState({ error: null, ok: true, saved: { onDate: "2027-01-01", isOpen: true } });
    render(
      <BusinessHoursExceptions
        action={vi.fn()}
        removeAction={vi.fn()}
        exceptions={[]}
        zoneLabel="Eastern"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      exceptionSavedMessage({ onDate: "2027-01-01", isOpen: true }),
    );
  });

  it("draws NO notice for an ok with nothing saved, rather than guessing an outcome", () => {
    withState({ error: null, ok: true });
    render(
      <BusinessHoursExceptions
        action={vi.fn()}
        removeAction={vi.fn()}
        exceptions={[]}
        zoneLabel="Eastern"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the weekly hours notice", () => {
  it("renders the builder's sentence, not one of its own", () => {
    withState({ error: null, ok: true });
    render(
      <BusinessHoursForm
        action={vi.fn()}
        days={[1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          is_open: true,
          start: "09:00",
          end: "17:00",
        }))}
        zoneLabel="Eastern"
        coverage={{ ok: false }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(HOURS_SAVED_MESSAGE);
  });
});
