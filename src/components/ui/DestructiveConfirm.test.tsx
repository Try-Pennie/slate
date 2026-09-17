// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DestructiveConfirm } from "@/components/ui/DestructiveConfirm";
import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";

// The shared two step confirm (#2455). A static scan cannot mount React, so
// `scripts/test-destructive-confirm.ts` can say the component NAMES the design
// system's classes and nothing more; these tests are what prove the button a
// person actually presses wears them, that the way out never does, and that the
// panel that carries them really is the neutral ground the contrast suite
// measured against.

const copy = {
  openLabel: "Cancel",
  question: "Cancel the time off for these 3 days?",
  consequence: "Your calendar clears and you can be booked on those days again.",
  dismissLabel: "Keep it",
  confirmLabel: "Yes, cancel",
  pendingLabel: "Cancelling",
};

function subject(extra: Partial<React.ComponentProps<typeof DestructiveConfirm>> = {}) {
  return <DestructiveConfirm {...copy} {...extra} />;
}

const open = () => screen.getByRole("button", { name: copy.openLabel });
const confirm = () => screen.getByRole("button", { name: copy.confirmLabel });
const dismiss = () => screen.getByRole("button", { name: copy.dismissLabel });

describe("DestructiveConfirm", () => {
  it("starts closed, with no destructive control on the page at all", () => {
    render(subject({ action: vi.fn() }));

    expect(open()).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.confirmLabel })).toBeNull();
    expect(screen.queryByText(copy.question)).toBeNull();
  });

  it("arming swaps the opener for the question, the consequence and the pair", async () => {
    const action = vi.fn();
    render(subject({ action }));

    await userEvent.click(open());

    expect(screen.getByText(copy.question)).toBeTruthy();
    expect(screen.getByText(copy.consequence)).toBeTruthy();
    expect(confirm()).toBeTruthy();
    expect(dismiss()).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.openLabel })).toBeNull();
    // Arming alone must never perform it.
    expect(action).not.toHaveBeenCalled();
  });

  it("the control that performs it wears the design system's destructive button", async () => {
    render(subject({ action: vi.fn() }));
    await userEvent.click(open());

    expect(confirm().className).toBe(btnDangerCls);
  });

  it("the way out is neutral, never destructive", async () => {
    render(subject({ action: vi.fn() }));
    await userEvent.click(open());

    // Backing out is the safe choice, so painting it in the warning colour would
    // give the escape the same treatment as the thing it escapes (#1875).
    expect(dismiss().className).toBe(btnSecondaryCls);
    expect(dismiss().className).not.toBe(btnDangerCls);
  });

  it("the panel's ground is the neutral field colour, not a rose wash", async () => {
    const { container } = render(subject({ action: vi.fn() }));
    await userEvent.click(open());

    // The measured reason: a rose label on a rose wash reads 3.89:1 on the page
    // and 4.17:1 on a card, and there is no alpha that fixes both. The panel says
    // destructive with its rose BORDER, which is full strength and clears 3:1 on
    // every surface it can land on.
    const panel = container.querySelector(".pn-confirm-enter") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.className).toContain("bg-[var(--field)]");
    expect(panel.className).toContain("border-[var(--error)]");
    expect(panel.className).not.toMatch(/bg-error/);
  });

  it("names the group by the question and describes it by the consequence", async () => {
    render(subject({ action: vi.fn() }));
    await userEvent.click(open());

    // Without this a screen reader hears "Keep it" and "Yes, cancel" with nothing
    // saying what of, and colour is not a signal it can read.
    const group = screen.getByRole("group", { name: copy.question });
    expect(group).toBeTruthy();
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(copy.consequence);
  });

  it("moves focus onto the confirm, and back to the opener on the way out", async () => {
    render(subject({ action: vi.fn() }));

    await userEvent.click(open());
    // The opener and the confirm swap places in the DOM, so without this a
    // keyboard user is dropped on the body, below a question that appeared above
    // them.
    await waitFor(() => expect(document.activeElement).toBe(confirm()));

    await userEvent.click(dismiss());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: copy.openLabel }),
      ),
    );
  });

  it("backing out performs nothing and leaves the confirm disarmed", async () => {
    const action = vi.fn();
    render(subject({ action }));

    await userEvent.click(open());
    await userEvent.click(dismiss());

    expect(screen.getByRole("button", { name: copy.openLabel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.confirmLabel })).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("only the confirming control submits, carrying the hidden inputs with it", async () => {
    const action = vi.fn();
    render(
      subject({
        action,
        hidden: <input type="hidden" name="request_id" value="req-42" />,
      }),
    );

    await userEvent.click(open());
    await userEvent.click(confirm());

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const form = action.mock.calls[0][0] as FormData;
    expect(form.get("request_id")).toBe("req-42");
  });

  it("with no action of its own it submits the form it is sitting inside", async () => {
    const outer = vi.fn();
    render(
      <form action={outer}>
        <input type="hidden" name="note" value="too busy" />
        {subject()}
      </form>,
    );

    await userEvent.click(open());
    await userEvent.click(confirm());

    // This is the manager's Decline: it has to live inside the reject form to
    // carry the optional note typed beside it.
    await waitFor(() => expect(outer).toHaveBeenCalledTimes(1));
    const form = outer.mock.calls[0][0] as FormData;
    expect(form.get("note")).toBe("too busy");
  });

  it("the control beside the opener disappears with it", async () => {
    render(
      subject({
        action: vi.fn(),
        beside: <button type="button">Edit</button>,
      }),
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    await userEvent.click(open());
    // The confirm REPLACES the row's controls rather than crowding in beside
    // them, so the row never reads as a run of links.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
