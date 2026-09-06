// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

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
    // #1947: a locked row shows the SAME switch as every other row, on and
    // unmovable, rather than the words "Always on". 3 "Other" rows plus
    // reassign's "owner_reassignment" is 4 locked rows.
    const locked = screen
      .getAllByRole("switch")
      .filter((el) => (el as HTMLInputElement).disabled) as HTMLInputElement[];
    expect(locked.length).toBe(4);
    // ON, and unmovable. A locked switch drawn off would say the opposite of
    // what it means.
    expect(locked.every((el) => el.checked)).toBe(true);
    // And it still says WHY, since a disabled control announces as unavailable
    // and never says why on its own (L109).
    for (const el of locked) {
      const describedBy = el.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toMatch(/cannot be retired/i);
    }
  });

  // #1947: "we don't need the word Label on every row". It goes from the SCREEN,
  // not from the markup: it is the field's accessible name, and deleting it
  // would leave an unnamed edit box (L577).
  it("keeps every label field named to a screen reader", () => {
    render(<ReasonOptionsEditor initial={initial} />);
    const fields = screen.getAllByLabelText("Label") as HTMLInputElement[];
    expect(fields.length).toBeGreaterThan(0);
    // Named, and the name is not drawn where it costs a line on every row.
    for (const f of fields) {
      const label = document.querySelector(`label[for="${f.id}"]`);
      expect(label?.className).toContain("sr-only");
    }
  });

  // The code used to be printed on every row where it can never change, and
  // hidden on the one row where the typing is choosing it permanently.
  it("previews the code a new reason will be stored as, while it is being typed", () => {
    render(<ReasonOptionsEditor initial={initial} />);
    fireEvent.click(screen.getAllByRole("button", { name: /add reason/i })[1]);
    const blank = screen.getAllByDisplayValue("").at(-1) as HTMLInputElement;
    fireEvent.change(blank, { target: { value: "Called the wrong number" } });
    expect(screen.getByText(/stored as called_the_wrong_number/i)).toBeTruthy();
  });

  // And on an existing row the stored code stays reachable, because renaming
  // never changes it: the label and the code diverge permanently, by design.
  it("keeps a stored code reachable on a row that already has one", () => {
    render(<ReasonOptionsEditor initial={initial} />);
    const li = liFor("No longer interested");
    const note = li.querySelector("[title]");
    expect(note?.getAttribute("title")).toMatch(/stored code: no_longer_interested/i);
  });

  it("adds a new blank reason row to the payload", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    const before = payload(container).cancel.length;
    // The cancel section's add button is the 2nd (reschedule, cancel, reassign order).
    fireEvent.click(screen.getAllByRole("button", { name: /add reason/i })[1]);
    expect(payload(container).cancel.length).toBe(before + 1);
    expect(payload(container).cancel.at(-1)).toEqual({ code: "", label: "", active: true });
  });

  // A MEASURED zero, because a component handed no usage knows nothing and asks
  // before retiring (#1657); this test's subject is the flip itself.
  it("retiring a reason flips its active flag in the payload", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} usage={emptyUsage} />);
    // Scope to the "No longer interested" row (there are several Active checkboxes).
    const row = (screen.getByDisplayValue("No longer interested") as HTMLElement).closest("li")!;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    const nli = payload(container).cancel.find((r) => r.code === "no_longer_interested")!;
    expect(nli.active).toBe(false);
  });

  // #990: the usage hint + confirm-before-retiring-a-used-reason guardrail.
  const emptyUsage = { reschedule: {}, cancel: {}, reassign: {} };
  const liFor = (label: string) => (screen.getByDisplayValue(label) as HTMLElement).closest("li")!;

  it("shows a per-row usage hint from the usage prop (#990)", () => {
    render(
      <ReasonOptionsEditor
        initial={initial}
        usage={{ ...emptyUsage, cancel: { no_longer_interested: 5 } }}
      />,
    );
    expect(within(liFor("No longer interested")).getByText(/used 5 times in the last 90 days/i)).toBeTruthy();
    // A reason with no recent use reads as such, not a blank.
    expect(within(liFor("Schedule conflict")).getByText(/not used in the last 90 days/i)).toBeTruthy();
  });

  it("asks to confirm before retiring a still-used reason, and does not flip until confirmed (#990)", () => {
    const { container } = render(
      <ReasonOptionsEditor
        initial={initial}
        usage={{ ...emptyUsage, cancel: { no_longer_interested: 12 } }}
      />,
    );
    const li = liFor("No longer interested");
    fireEvent.click(li.querySelector('input[type="checkbox"]') as HTMLInputElement);

    // The toggle is held: the payload still has the reason active...
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(true);
    // ...and an inline confirm group appears with the retire action.
    const confirm = within(li).getByRole("group", { name: /confirm retiring/i });
    expect(within(confirm).getByText(/used 12 times/i)).toBeTruthy();
    expect(within(confirm).getByRole("button", { name: /retire it anyway/i })).toBeTruthy();
  });

  it("confirming the retire flips active; keeping it active cancels (#990)", () => {
    const { container } = render(
      <ReasonOptionsEditor
        initial={initial}
        usage={{ ...emptyUsage, cancel: { no_longer_interested: 12 } }}
      />,
    );
    const cb = () => liFor("No longer interested").querySelector('input[type="checkbox"]') as HTMLInputElement;

    // Keep active: the confirm dismisses and the reason stays active.
    fireEvent.click(cb());
    fireEvent.click(within(liFor("No longer interested")).getByRole("button", { name: /keep it active/i }));
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(true);
    expect(within(liFor("No longer interested")).queryByRole("button", { name: /retire it anyway/i })).toBeNull();

    // Retire anyway: now it flips.
    fireEvent.click(cb());
    fireEvent.click(within(liFor("No longer interested")).getByRole("button", { name: /retire it anyway/i }));
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(false);
  });

  it("retires an UNUSED reason immediately with no confirm (#990)", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} usage={emptyUsage} />);
    const li = liFor("No longer interested");
    fireEvent.click(li.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(within(li).queryByRole("button", { name: /retire it anyway/i })).toBeNull();
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(false);
  });

  // #1657: the counts come from a read that can FAIL, and zero is a real answer
  // ("nobody has picked this in 90 days"), so an unmeasured count must not
  // borrow it. Null is could-not-measure, and it fails toward ASKING.
  it("says the recent use could not be read rather than claiming the reason is unused", () => {
    render(<ReasonOptionsEditor initial={initial} usage={null} />);
    const li = liFor("No longer interested");
    expect(within(li).getByText(/recent use could not be read/i)).toBeTruthy();
    expect(within(li).queryByText(/not used in the last/i)).toBeNull();
  });

  it("still asks before retiring a reason whose recent use could not be read", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} usage={null} />);
    const li = liFor("No longer interested");
    fireEvent.click(li.querySelector('input[type="checkbox"]') as HTMLInputElement);
    // The confirm appears, and nothing has flipped yet.
    expect(within(liFor("No longer interested")).getByRole("button", { name: /retire it anyway/i })).toBeTruthy();
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(true);
    // And the question says what is unknown, rather than asserting a count. It
    // appears twice in the row: the standing hint, and inside the confirm.
    expect(
      within(liFor("No longer interested")).getAllByText(/recent use could not be read/i).length,
    ).toBeGreaterThan(1);
  });

  // The control: a MEASURED zero still retires straight through, so the confirm
  // above is a response to the unmeasured state and not to every retire.
  it("CONTROL: a measured zero still retires with no confirm", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} usage={emptyUsage} />);
    const li = liFor("No longer interested");
    fireEvent.click(li.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(within(li).queryByRole("button", { name: /retire it anyway/i })).toBeNull();
    expect(payload(container).cancel.find((r) => r.code === "no_longer_interested")!.active).toBe(false);
  });

  it("reorders a reason with the down button, changing payload order", () => {
    const { container } = render(<ReasonOptionsEditor initial={initial} />);
    // Move the first cancel reason ("No longer interested") down past "Other".
    fireEvent.click(screen.getByRole("button", { name: /move No longer interested down/i }));
    expect(payload(container).cancel.map((r) => r.code)).toEqual(["other", "no_longer_interested"]);
  });
});
