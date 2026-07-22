// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The editor imports the server action only to wire the form's `action`; mock it
// so jsdom doesn't pull in server-only deps (supabase, next/headers).
vi.mock("@/app/admin/actions", () => ({ setReasonOptions: vi.fn() }));

import ReasonOptionsEditor from "@/components/ReasonOptionsEditor";
import type { ReasonOptionRow } from "@/lib/booking/reason-options";

const row = (
  action: ReasonOptionRow["action"],
  code: string,
  label: string,
  sort_order: number,
  active = true,
  locked = false,
): ReasonOptionRow => ({ action, code, label, sort_order, active, locked });

const initial = {
  reschedule: [row("reschedule", "schedule_conflict", "Schedule conflict", 0), row("reschedule", "other", "Other", 1, true, true)],
  cancel: [row("cancel", "no_longer_interested", "No longer interested", 0), row("cancel", "other", "Other", 1, true, true)],
  reassign: [row("reassign", "owner_reassignment", "Owner reassignment", 0, true, true), row("reassign", "other", "Other", 1, true, true)],
};

/** The current submitted payload (the hidden input's value), parsed. */
function payload(container: HTMLElement): Record<string, { code: string; label: string; active: boolean }[]> {
  const input = container.querySelector('input[name="payload"]') as HTMLInputElement;
  return JSON.parse(input.value);
}

describe("ReasonOptionsEditor", () => {
  it("renders the initial rows and serializes them into the payload", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    expect((screen.getByDisplayValue("Schedule conflict") as HTMLInputElement).value).toBe("Schedule conflict");
    const p = payload(container);
    expect(p.cancel.map((r) => r.code)).toEqual(["no_longer_interested", "other"]);
  });

  it("locks system rows: their label is read-only and they cannot be retired", () => {
    render(<ReasonOptionsEditor initial={initial} />);
    // Two "Other" rows are locked (reschedule + cancel + reassign each have one).
    const otherInputs = screen.getAllByDisplayValue("Other") as HTMLInputElement[];
    expect(otherInputs.every((i) => i.disabled)).toBe(true);
    // Locked rows show "Always on", never an Active checkbox to retire them:
    // 3 "Other" rows + reassign's "owner_reassignment" = 4 locked rows.
    expect(screen.getAllByText(/always on/i).length).toBe(4);
  });

  it("adds a new blank reason row to the payload", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    const before = payload(container).cancel.length;
    // The cancel section's add button is the 2nd (reschedule, cancel, reassign order).
    fireEvent.click(screen.getAllByRole("button", { name: /add reason/i })[1]);
    expect(payload(container).cancel.length).toBe(before + 1);
    expect(payload(container).cancel.at(-1)).toEqual({ code: "", label: "", active: true });
  });

  it("retiring a reason flips its active flag in the payload", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    // Scope to the "No longer interested" row (there are several Active checkboxes).
    const row = (screen.getByDisplayValue("No longer interested") as HTMLElement).closest("li")!;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    const nli = payload(container).cancel.find((r) => r.code === "no_longer_interested")!;
    expect(nli.active).toBe(false);
  });

  it("reorders a reason with the down button, changing payload order", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    // Move the first cancel reason ("No longer interested") down past "Other".
    fireEvent.click(screen.getByRole("button", { name: /move No longer interested down/i }));
    expect(payload(container).cancel.map((r) => r.code)).toEqual(["other", "no_longer_interested"]);
  });
});
