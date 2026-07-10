// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SubmitButton } from "@/components/ui/SubmitButton";

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
});
