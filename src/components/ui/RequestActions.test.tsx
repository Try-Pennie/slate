// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestActions } from "@/components/ui/RequestActions";
import {
  CANCEL_ACT_WORDS,
  cancelConfirmCopy,
} from "@/lib/ooo/cancel-copy";
import type { OooStatus } from "@/lib/db/types";

// EditRequestButton (rendered in the default state) pushes through the router,
// so the component needs next/navigation stubbed even though these tests never
// drive the Edit path.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// Regression coverage for the agent's destructive control (#193, #2406).
//
// Cancelling is destructive, so the first click must only ARM an inline confirm
// that REPLACES the Edit/Cancel pair; the way out must disarm it; and only the
// confirming control may run the server action, carrying the request id.
//
// #2406 added the second half: a PENDING request is withdrawn and an APPROVED
// one is cancelled, and those are different acts with different consequences.
// A static scan cannot mount React, so these tests are what prove the component
// renders the BUILDER's exact sentences rather than keeping its own inline copy,
// which would leave the builder and the screen free to disagree while every
// test about the builder still passed.
function renderActions(
  cancelAction: (form: FormData) => void,
  opts: { requestId?: string; status?: OooStatus; dayCount?: number } = {},
) {
  return render(
    <RequestActions
      requestId={opts.requestId ?? "req-1"}
      status={opts.status ?? "pending"}
      dayCount={opts.dayCount ?? 1}
      cancelAction={cancelAction}
    />,
  );
}

const withdraw = CANCEL_ACT_WORDS.withdraw;
const cancel = CANCEL_ACT_WORDS.cancel;

describe("RequestActions", () => {
  it("starts with Edit and the act's own control, and no destructive confirm", () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction, { status: "approved" });

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: cancel.control })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: cancel.confirmControl }),
    ).toBeNull();
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("names the act by the request's state, so the row says which one it performs", () => {
    renderActions(vi.fn(), { status: "pending" });
    expect(screen.getByRole("button", { name: withdraw.control })).toBeTruthy();
    expect(screen.queryByRole("button", { name: cancel.control })).toBeNull();
  });

  it("arms a confirm that replaces the Edit/Cancel pair", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction, { status: "approved" });

    await userEvent.click(screen.getByRole("button", { name: cancel.control }));

    expect(
      screen.getByRole("button", { name: cancel.confirmControl }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: cancel.dismiss })).toBeTruthy();
    // The Edit and the arming control are gone, not sitting alongside the confirm.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: cancel.control })).toHaveLength(
      0,
    );
    // Arming alone must not run the destructive action.
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("backs out to Edit and the act's control without performing it", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction, { status: "approved" });

    await userEvent.click(screen.getByRole("button", { name: cancel.control }));
    await userEvent.click(screen.getByRole("button", { name: cancel.dismiss }));

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: cancel.control })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: cancel.confirmControl }),
    ).toBeNull();
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("the way out of the confirm is never named after the act it backs out of", async () => {
    renderActions(vi.fn(), { status: "approved" });
    await userEvent.click(screen.getByRole("button", { name: cancel.control }));

    // The dismiss control and the destructive control may not share a word, or
    // the confirm offers "Cancel" as the way to back out of cancelling (#2406).
    expect(cancel.dismiss).not.toBe(cancel.control);
    expect(screen.getByRole("button", { name: cancel.dismiss })).toBeTruthy();
  });

  it("the confirming control runs the action with the request id in its form data", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction, { requestId: "req-42", status: "approved" });

    await userEvent.click(screen.getByRole("button", { name: cancel.control }));
    await userEvent.click(
      screen.getByRole("button", { name: cancel.confirmControl }),
    );

    await waitFor(() => expect(cancelAction).toHaveBeenCalledTimes(1));
    const form = cancelAction.mock.calls[0][0] as FormData;
    expect(form.get("request_id")).toBe("req-42");
  });

  // --- the copy on screen IS the builder's output --------------------------

  it("renders the approved request's own confirmation, word for word", async () => {
    const expected = cancelConfirmCopy("cancel", 5);
    renderActions(vi.fn(), { status: "approved", dayCount: 5 });

    await userEvent.click(screen.getByRole("button", { name: cancel.control }));

    expect(screen.getByText(expected.question)).toBeTruthy();
    expect(screen.getByText(expected.consequence)).toBeTruthy();
  });

  it("renders the pending request's own confirmation, word for word", async () => {
    const expected = cancelConfirmCopy("withdraw", 5);
    renderActions(vi.fn(), { status: "pending", dayCount: 5 });

    await userEvent.click(screen.getByRole("button", { name: withdraw.control }));

    expect(screen.getByText(expected.question)).toBeTruthy();
    expect(screen.getByText(expected.consequence)).toBeTruthy();
  });

  it("asks a DIFFERENT question of an approved request than of a pending one", async () => {
    const pendingCopy = cancelConfirmCopy("withdraw", 1);
    const approvedCopy = cancelConfirmCopy("cancel", 1);
    expect(approvedCopy.question).not.toBe(pendingCopy.question);

    const { unmount } = renderActions(vi.fn(), { status: "pending" });
    await userEvent.click(screen.getByRole("button", { name: withdraw.control }));
    expect(screen.getByText(pendingCopy.question)).toBeTruthy();
    // The approved sentence, and its claim about the calendar, are nowhere on a
    // pending request's confirm.
    expect(screen.queryByText(approvedCopy.question)).toBeNull();
    expect(screen.queryByText(approvedCopy.consequence)).toBeNull();
    unmount();

    renderActions(vi.fn(), { status: "approved" });
    await userEvent.click(screen.getByRole("button", { name: cancel.control }));
    expect(screen.getByText(approvedCopy.question)).toBeTruthy();
    expect(screen.queryByText(pendingCopy.question)).toBeNull();
  });

  it("the confirm's question is announced as the group's own label", async () => {
    const expected = cancelConfirmCopy("cancel", 1);
    renderActions(vi.fn(), { status: "approved" });

    await userEvent.click(screen.getByRole("button", { name: cancel.control }));

    // A screen reader reaching the two buttons must be told which act it is
    // about to confirm, not just "Yes, cancel" (colour and position are not a
    // signal it can read).
    expect(
      screen.getByRole("group", { name: expected.question }),
    ).toBeTruthy();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
