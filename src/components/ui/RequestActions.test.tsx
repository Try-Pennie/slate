// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestActions } from "@/components/ui/RequestActions";

// EditRequestButton (rendered in the default state) pushes through the router,
// so the component needs next/navigation stubbed even though these tests never
// drive the Edit path.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// Regression coverage for the agent's cancel control (#193). Cancelling is
// destructive, so the first Cancel click must only ARM an inline confirm that
// REPLACES the Edit/Cancel pair; Keep it must disarm it; and only the confirmed
// Yes, cancel may run the server action, carrying the request id it was given.
function renderActions(cancelAction: (form: FormData) => void, requestId = "req-1") {
  return render(
    <RequestActions requestId={requestId} cancelAction={cancelAction} />,
  );
}

describe("RequestActions", () => {
  it("starts with Edit and Cancel and no destructive confirm", () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction);

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, cancel" })).toBeNull();
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("Cancel arms a confirm that replaces the Edit/Cancel pair", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Cancel this?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
    // The Edit and plain Cancel are gone, not sitting alongside the confirm.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // Arming alone must not run the destructive action.
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("Keep it disarms back to Edit and Cancel without cancelling", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, cancel" })).toBeNull();
    expect(cancelAction).not.toHaveBeenCalled();
  });

  it("Yes, cancel runs the action with the request id in its form data", async () => {
    const cancelAction = vi.fn();
    renderActions(cancelAction, "req-42");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));

    await waitFor(() => expect(cancelAction).toHaveBeenCalledTimes(1));
    const form = cancelAction.mock.calls[0][0] as FormData;
    expect(form.get("request_id")).toBe("req-42");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
