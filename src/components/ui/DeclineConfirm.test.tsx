// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclineConfirm } from "@/components/ui/DeclineConfirm";

// Regression coverage for the manager's two step decline (#193). Declining
// rejects an agent's real time off and DMs them, so the guard is the whole
// point: the first click must only ARM the confirm, never submit, and backing
// out must fully disarm it. The component lives inside the reject <form>, so the
// tests render it in one and assert whether that form's action ran.
function renderInForm(action: (form: FormData) => void, agentName = "Ada") {
  return render(
    <form action={action}>
      <DeclineConfirm agentName={agentName} />
    </form>,
  );
}

describe("DeclineConfirm", () => {
  it("starts collapsed: only the Decline button, no confirm and no submit", () => {
    const action = vi.fn();
    renderInForm(action);

    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, decline" })).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("arming the confirm swaps in the Keep it / Yes, decline pair and names the agent", async () => {
    const action = vi.fn();
    renderInForm(action, "Bella");

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    // The plain Decline button is REPLACED, not merely joined, so the row can't
    // read as a run of links, and the agent is named in the prompt.
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.getByText(/Decline Bella's request\?/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, decline" })).toBeTruthy();
    // Arming alone must not submit.
    expect(action).not.toHaveBeenCalled();
  });

  it("Keep it disarms back to the collapsed Decline button without submitting", async () => {
    const action = vi.fn();
    renderInForm(action);

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, decline" })).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("only the confirmed Yes, decline submits the enclosing form", async () => {
    const action = vi.fn();
    renderInForm(action);

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, decline" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
