import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3102: the secret key client had no deadline, so a Supabase that accepted the
// connection and never answered held a lead's confirm until the browser gave up.
// These drive the real client against a fetch that never settles, on fake timers,
// so nothing here waits for real time.

vi.mock("@/lib/env", () => ({
  publicSupabaseUrl: () => "https://x.test",
  supabaseSecretKey: () => "sb_secret_test",
}));

import { supabaseAdmin } from "./admin";
import { SUPABASE_FETCH_TIMEOUT_MS } from "./fetch";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { unwrap } from "@/lib/db/result";

describe("supabaseAdmin deadline (#3102)", () => {
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => {
      calls++;
      return new Promise<Response>(() => {});
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is sized below the booker's own 20 second abort", () => {
    expect(SUPABASE_FETCH_TIMEOUT_MS).toBeLessThan(20_000);
  });

  it("turns a hung read into a recognisable error once the deadline passes", async () => {
    let settled = false;
    const read = Promise.resolve(supabaseAdmin().from("buckets").select("id")).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(SUPABASE_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await read;
    expect(settled).toBe(true);
    expect(res.data).toBeNull();
    expect(() => unwrap(res, "buckets")).toThrow(/DeadlineExceededError/);
    let thrown: unknown;
    try {
      unwrap(res, "buckets");
    } catch (e) {
      thrown = e;
    }
    expect(isDeadlineExceeded(thrown)).toBe(true);
    // One attempt: PostgREST's GET retry would otherwise multiply the wait.
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
