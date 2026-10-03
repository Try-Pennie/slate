import { describe, it, expect, vi, afterEach } from "vitest";

// #3102 with #3104: a load run injects faults into the Supabase client through a
// fetch wrapper of its own. The deadline has to sit ON TOP of whatever fetch the
// client is given, so an injected hang is cut by the same deadline a real one is;
// a wrapper placed outside it would hang the run past every limit it is judging.

import { supabaseFetchOver, SUPABASE_FETCH_TIMEOUT_MS } from "./fetch";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";

afterEach(() => vi.useRealTimers());

describe("supabaseFetchOver (#3102)", () => {
  it("holds whatever fetch it wraps, a fault injector included, to the Supabase deadline", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const injectedHang = (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Promise<Response>(() => {});
    };
    let outcome: unknown = "pending";
    supabaseFetchOver(injectedHang)("https://x.test/rest/v1/buckets").then(
      () => (outcome = "resolved"),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(SUPABASE_FETCH_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(DeadlineExceededError);
    expect(seen).toEqual(["https://x.test/rest/v1/buckets"]);
  });
});
