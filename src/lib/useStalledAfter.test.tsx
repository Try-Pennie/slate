// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStalledAfter } from "@/lib/useStalledAfter";

// #626: one shared watchdog for booking-flow async actions. While an action is
// active, flip to `stalled` after `ms` so the UI can surface a distinct
// "still working" state instead of an unchanging label. Resets the moment the
// action ends (success or error) so the next run starts clean.

afterEach(() => vi.useRealTimers());

describe("useStalledAfter", () => {
  it("stays false before the delay elapses", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStalledAfter(true, 10000));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(9999));
    expect(result.current).toBe(false);
  });

  it("flips to true once the delay elapses while active", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStalledAfter(true, 10000));
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current).toBe(true);
  });

  it("never trips while inactive", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStalledAfter(false, 10000));
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current).toBe(false);
  });

  it("resets to false when the action ends before the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ active }) => useStalledAfter(active, 10000),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(5000));
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current).toBe(false);
  });

  it("clears a prior stall when the action restarts", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ active }) => useStalledAfter(active, 10000),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
    rerender({ active: true });
    expect(result.current).toBe(false);
  });
});
