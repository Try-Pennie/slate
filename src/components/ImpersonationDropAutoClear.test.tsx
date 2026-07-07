import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ImpersonationDropAutoClear } from "@/components/ImpersonationDropAutoClear";
import { endDroppedImpersonation } from "@/app/admin/actions";

// #652: the notice clears the stale cookie hands-off. This guards that the effect
// actually fires the clear exactly once with the right reason (and never leaves it
// to the user), and renders nothing itself.
vi.mock("@/app/admin/actions", () => ({
  endDroppedImpersonation: vi.fn(async () => {}),
}));

describe("ImpersonationDropAutoClear (#652)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires the clear action once on mount with the reason", () => {
    const { container } = render(<ImpersonationDropAutoClear reason="expired" />);
    expect(endDroppedImpersonation).toHaveBeenCalledTimes(1);
    expect(endDroppedImpersonation).toHaveBeenCalledWith("expired");
    // Renders nothing; it's a background effect, not UI.
    expect(container.childElementCount).toBe(0);
  });

  it("does not fire again on re-render (guards against a double clear)", () => {
    const { rerender } = render(<ImpersonationDropAutoClear reason="unavailable" />);
    rerender(<ImpersonationDropAutoClear reason="unavailable" />);
    expect(endDroppedImpersonation).toHaveBeenCalledTimes(1);
  });
});
