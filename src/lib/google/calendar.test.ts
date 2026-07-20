import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #922: the bookable reachability probe passes a bounded timeoutMs into
// listCalendars so a hanging Google can't stall the 'Make bookable' click. These
// tests prove listCalendars threads that bound into gfetch's abort wiring: a
// fetch that never responds is aborted once the bound elapses, and a fetch that
// responds in time is left alone. getDelegatedToken and global fetch are stubbed
// so nothing hits Google.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);

import { listCalendars } from "./calendar";

describe("listCalendars timeout (#922)", () => {
  beforeEach(() => dwd.getDelegatedToken.mockResolvedValue("tok"));
  afterEach(() => vi.unstubAllGlobals());

  it("aborts a hung calendarList fetch once timeoutMs elapses", async () => {
    // The fetch never resolves on its own; it rejects only if the abort signal
    // fires, exactly as a real hung Google request would under an AbortController.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
    );
    await expect(listCalendars("a@b.com", 20)).rejects.toThrow(/abort/i);
    expect(dwd.getDelegatedToken).toHaveBeenCalledWith("a@b.com");
  });

  it("does not abort a calendarList fetch that responds before timeoutMs", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: [{ id: "primary" }] }), { status: 200 }),
    );
    await expect(listCalendars("a@b.com", 20000)).resolves.toEqual([{ id: "primary" }]);
  });
});
