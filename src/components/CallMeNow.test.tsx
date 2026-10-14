// @vitest-environment jsdom
//
// #3718: the Call me now row's own state. Its screens are tested through the real
// Booker in Booker.inline.test.tsx; this pins the one rule that needs a clock: a
// check that never answers gives up and hides the row, as a press gives up and
// fails, on fake timers rather than a real twenty second wait (L524).
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCallMeNow } from "@/components/CallMeNow";

const CONFIG = {
  position: "above" as const,
  leadId: "00QUi000010889ZMAQ",
  email: "maria@example.com",
  phone: null,
  submissionId: null,
  firstName: "Maria",
};

afterEach(() => vi.useRealTimers());

describe("useCallMeNow (#3718)", () => {
  it("gives up on a check that never answers, and hides the row rather than leaving it pending", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useCallMeNow(CONFIG));
    expect(result.current.phase).toBe("checking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.phase).toBe("hidden");
  });
});
