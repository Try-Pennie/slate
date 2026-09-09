// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SubmitButton, SubmitPending } from "@/components/ui/SubmitButton";

// The admin/settings server-action forms (#630) all rely on this one button for
// their in-flight feedback: while the action runs it must disable (so a
// non-idempotent replay/resend can't be double-fired), mark aria-busy, and swap
// its label to a "doing it" verb. This locks that contract.

function Harness({ pendingLabel = "Saving…" }: { pendingLabel?: string }) {
  // A form action that never resolves keeps useFormStatus pending.
  const action = () => new Promise<void>(() => {});
  return (
    <form action={action} aria-label="test-form">
      <SubmitButton pendingLabel={pendingLabel}>Save default</SubmitButton>
    </form>
  );
}

describe("SubmitButton", () => {
  it("is enabled and shows its label before submit", () => {
    render(<Harness />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(btn.textContent).toBe("Save default");
  });

  it("disables, marks aria-busy, and shows the pending label while the action runs", async () => {
    render(<Harness pendingLabel="Saving…" />);
    const form = screen.getByLabelText("test-form") as HTMLFormElement;

    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
    });

    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.textContent).toContain("Saving…");
    expect(btn.textContent).not.toContain("Save default");
  });

  // #1769: the two states past "it started", which existed and had never been
  // exercised. They are the whole reason this control is not just a disabled
  // button: a spinner looks identical whether the work is progressing, hung, or
  // dead, and the action this sits on (make bookable) makes a LIVE Google calendar
  // call before it writes anything, so the slowest action in the app is the one
  // where the difference matters.
  //
  // They are driven by HANDING the renderer an elapsed time, not by waiting for
  // one. Two reasons, and the second is the load bearing one:
  //
  //  * A test that sleeps twenty seconds to check a twenty second threshold is
  //    asserting about the machine's load (L290).
  //  * Under jsdom, the interval's state update DROPS the form's pending state, so
  //    a test that submits and then waits watches the button fall back to its idle
  //    label and measures the harness rather than the button.
  //
  // The wiring is real and was measured in a real browser on 2026-09-03, with the
  // action's POST held and never forwarded so nothing was written: 200ms and 1.5s
  // read "Saving…", 4s read "Saving…4s", 8s read "Saving…8s", and from 21s it read
  // "Still working 21s" with "This is taking longer than usual." announced. What is
  // asserted below is the same rendering code, given the elapsed time directly.
  describe("what it says while a wait goes on", () => {
    const say = (elapsedMs: number) =>
      render(<SubmitPending elapsedMs={elapsedMs} pendingLabel="Making bookable" />);

    it("names the action it started, with nothing about how long, while it is quick", () => {
      const { container } = say(0);
      expect(container.textContent).toContain("Making bookable");
      // A count that flickered on for a two second save would be noise.
      expect(container.textContent).not.toMatch(/\ds/);
      say(2_900).unmount();
    });

    it("shows it is STILL ALIVE once the wait stops being instant", () => {
      const { container } = say(5_000);
      expect(container.textContent).toContain("Making bookable");
      // The elapsed count is the difference between progressing and hung.
      expect(container.textContent).toContain("5s");
    });

    it("says the wait has STALLED, in words, once it stops being normal", () => {
      const { container } = say(21_000);

      expect(container.textContent).toContain("Still working");
      expect(container.textContent).not.toContain("Making bookable");
      expect(container.textContent).toContain("21s");
      // In words and announced, not left as a spinner or a colour.
      expect(container.querySelector('[role="status"]')?.textContent).toMatch(/taking longer/i);
    });

    it("says nothing about a stall while the wait is still normal", () => {
      const { container } = say(5_000);
      // The live region must be EMPTY here, or a screen reader hears "taking
      // longer than usual" on every ordinary save.
      expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    });

    it("takes a fuller accessible name than its visible label (#2120)", () => {
      // A row of fields where each carries its own save cannot spell the field
      // out on every button without the row becoming a row of sentences, and a
      // page with several buttons all reading "Save" is one a screen reader
      // cannot tell apart. The accessible name CONTAINS the visible label, which
      // is what keeps a voice control user able to say what they see (WCAG 2.5.3).
      const action = () => new Promise<void>(() => {});
      render(
        <form action={action}>
          <SubmitButton pendingLabel="Saving" ariaLabel="Save legal eligible">
            Save
          </SubmitButton>
        </form>,
      );
      const btn = screen.getByRole("button", { name: "Save legal eligible" });
      expect(btn.textContent).toBe("Save");
    });

    it("keeps its visible text as its name when no fuller one is given", () => {
      const action = () => new Promise<void>(() => {});
      render(
        <form action={action}>
          <SubmitButton pendingLabel="Saving">Save hours</SubmitButton>
        </form>,
      );
      expect(screen.getByRole("button", { name: "Save hours" }).getAttribute("aria-label")).toBeNull();
    });

    it("crosses each threshold at the moment it is reached, not a tick later", () => {
      // The boundaries themselves, because an off by one here is what makes a
      // state either unreachable or permanent.
      expect(render(<SubmitPending elapsedMs={2_999} pendingLabel="Saving" />).container.textContent)
        .not.toMatch(/\ds/);
      expect(render(<SubmitPending elapsedMs={3_000} pendingLabel="Saving" />).container.textContent)
        .toContain("3s");
      expect(render(<SubmitPending elapsedMs={19_999} pendingLabel="Saving" />).container.textContent)
        .toContain("Saving");
      expect(render(<SubmitPending elapsedMs={20_000} pendingLabel="Saving" />).container.textContent)
        .toContain("Still working");
    });
  });
});
