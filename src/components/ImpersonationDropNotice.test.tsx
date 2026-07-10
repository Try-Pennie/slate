// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImpersonationDropNotice } from "@/components/ImpersonationDropNotice";

// #652: when a "view as" session is silently dropped, the admin must SEE why,
// not just find themselves back on their own view with no explanation. The notice
// distinguishes a timeout from the person becoming unavailable, and is announced
// to screen readers. The server action is mocked so mounting the auto-clear child
// (which fires it on mount) doesn't reach server-only code.
vi.mock("@/app/admin/actions", () => ({
  endDroppedImpersonation: vi.fn(async () => {}),
}));

describe("ImpersonationDropNotice (#652)", () => {
  it("explains a timed-out session for the expired reason", () => {
    render(<ImpersonationDropNotice reason="expired" />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/timed out/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("explains an unavailable target for the unavailable reason", () => {
    render(<ImpersonationDropNotice reason="unavailable" />);
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
    // Must NOT claim a timeout when the person became ineligible instead.
    expect(screen.queryByText(/timed out/i)).toBeNull();
  });
});
