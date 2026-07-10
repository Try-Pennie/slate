// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useFetchList } from "@/components/AsyncList";

// #698: useFetchList is the shared loader behind the reschedule/reassign panels
// (ManageBooking + AdminBookingActions). Like the Booker (#629) it fetches on a
// prop/state change, so it must abort a superseded/unmounted request and never
// let a stale response leak into state. These tests pin that guard.

const extract = (json: unknown): string[] =>
  Array.isArray((json as { items?: string[] })?.items)
    ? (json as { items: string[] }).items
    : [];

// Manual promise so the test controls exactly when a fetch resolves, and records
// the AbortSignal handed to each call.
type Deferred = {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (items: string[]) => void;
};

function fetchController() {
  const calls: Deferred[] = [];
  const fn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve) => {
      calls.push({
        url: String(url),
        signal: init?.signal ?? undefined,
        resolve: (items) =>
          resolve({ ok: true, json: async () => ({ items }) } as Response),
      });
    });
  });
  return { calls, fn };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFetchList out-of-order guard (#698)", () => {
  it("aborts the superseded fetch when the url changes mid-flight", async () => {
    const { calls, fn } = fetchController();
    global.fetch = fn as unknown as typeof fetch;

    const { rerender } = renderHook(
      ({ url }: { url: string }) => useFetchList(url, true, extract),
      { initialProps: { url: "/api/a" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    // Navigate to a new target while the first fetch is still in flight.
    rerender({ url: "/api/b" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);

    // The first (now superseded) fetch must have been aborted.
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal?.aborted).toBe(true);
    // The live fetch is not aborted.
    expect(calls[1].signal?.aborted).toBe(false);
  });

  it("ignores a stale response that resolves after the newer one", async () => {
    const { calls, fn } = fetchController();
    global.fetch = fn as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useFetchList(url, true, extract),
      { initialProps: { url: "/api/a" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ url: "/api/b" });
    await act(async () => {
      await Promise.resolve();
    });

    // Newer (B) resolves first, then the stale (A) resolves last.
    await act(async () => {
      calls[1].resolve(["b-1", "b-2"]);
      await Promise.resolve();
    });
    await act(async () => {
      calls[0].resolve(["a-only"]);
      await Promise.resolve();
    });

    // B's result stands; the stale A response must not clobber it.
    expect(result.current.items).toEqual(["b-1", "b-2"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
  });

  it("aborts the in-flight fetch on unmount", async () => {
    const { calls, fn } = fetchController();
    global.fetch = fn as unknown as typeof fetch;

    const { unmount } = renderHook(() => useFetchList("/api/a", true, extract));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    unmount();
    expect(calls[0].signal?.aborted).toBe(true);
  });
});
