// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OooForm } from "@/components/ui/OooForm";
import type { OooFormState } from "@/app/me/actions";

// Regression coverage for the form's client logic (two of these reproduce bugs
// that shipped this session): a validation error must keep typed values, the
// stall watchdog must fire on a wedged submit, and a fresh submit must dismiss a
// stale success banner. See #145.

const baseProps = {
  editing: null,
  managerName: "Bobby",
  defaultTz: "America/New_York",
  tzOptions: [{ value: "America/New_York", label: "New York (ET)" }],
  bounds: { minISO: "2024-01-01", maxISO: "2028-12-31", todayISO: "2026-06-17" },
  successMessage: null as string | null,
  successKind: null as string | null,
};

function renderForm(
  action: (prev: OooFormState, form: FormData) => Promise<OooFormState>,
  overrides: Partial<typeof baseProps> = {},
) {
  return render(<OooForm {...baseProps} {...overrides} action={action} />);
}

const formEl = (): HTMLFormElement =>
  document.getElementById("ooo-form") as HTMLFormElement;

describe("OooForm", () => {
  it("keeps the typed reason/notes when the action returns a validation error", async () => {
    const action = vi.fn(
      async (): Promise<OooFormState> => ({ error: "Pick a start and end date." }),
    );
    renderForm(action);

    const reason = screen.getByLabelText("Reason") as HTMLInputElement;
    const notes = screen.getByLabelText(
      "Notes for your manager (optional)",
    ) as HTMLInputElement;
    await userEvent.type(reason, "Vacation");
    await userEvent.type(notes, "Back Monday");

    fireEvent.submit(formEl());

    // The error surfaces inline and the controlled fields survive React 19's
    // post-action form reset.
    expect(await screen.findByText("Pick a start and end date.")).toBeTruthy();
    expect(reason.value).toBe("Vacation");
    expect(notes.value).toBe("Back Monday");
  });

  it("shows the stall watchdog when a submit stays in flight", async () => {
    vi.useFakeTimers();
    // An action that never resolves keeps the form pending past the watchdog.
    const action = vi.fn(() => new Promise<OooFormState>(() => {}));
    renderForm(action);

    fireEvent.submit(formEl());
    // Let the pending transition commit, then trip the 15s watchdog.
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(15000);
    });

    expect(
      screen.getByText(/taking longer than it should/i),
    ).toBeTruthy();
    vi.useRealTimers();
  });

  it("dismisses a stale success banner the instant a new submit starts", async () => {
    const action = vi.fn(() => new Promise<OooFormState>(() => {}));
    renderForm(action, {
      successMessage: "You're set for Tue, Oct 7 2025. Bobby will confirm.",
      successKind: "sent",
    });

    // The post-redirect success banner is showing.
    expect(screen.getByText("Request sent!")).toBeTruthy();

    fireEvent.submit(formEl());

    // Starting another submit marks the prior success stale, so it disappears.
    await waitFor(() =>
      expect(screen.queryByText("Request sent!")).toBeNull(),
    );
  });

  // #1007: an agent whose correct zone isn't in the curated list can still pick it
  // through the searchable full-IANA fallback, matching the booker (#219) and the
  // manage/reschedule screen (#1000).
  it("applies a non-curated zone picked from the 'more zones' search and collapses it", async () => {
    renderForm(vi.fn(async (): Promise<OooFormState> => ({ error: null })));
    const select = screen.getByLabelText("Timezone") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: /more zones/i })).toBeTruthy();

    fireEvent.change(select, { target: { value: "__more_zones__" } });
    const search = (await screen.findByLabelText("Search all timezones")) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Australia/Sydney" } });

    // The zone is applied (the timezone field now submits it) and the search collapses.
    expect(select.value).toBe("Australia/Sydney");
    expect(screen.queryByLabelText("Search all timezones")).toBeNull();
  });

  it("ignores an invalid zone typed into the fallback search (no bad zone applied)", async () => {
    renderForm(vi.fn(async (): Promise<OooFormState> => ({ error: null })));
    const select = screen.getByLabelText("Timezone") as HTMLSelectElement;
    const before = select.value;

    fireEvent.change(select, { target: { value: "__more_zones__" } });
    const search = (await screen.findByLabelText("Search all timezones")) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Not/AZone" } });

    // Junk is rejected: the applied zone is unchanged and the search stays open.
    expect(select.value).toBe(before);
    expect(screen.getByLabelText("Search all timezones")).toBeTruthy();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
