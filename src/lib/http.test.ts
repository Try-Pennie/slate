import { describe, it, expect, vi, afterEach } from "vitest";
import { postJson } from "@/lib/http";

// #625: the shared client POST helper must ALWAYS resolve with { ok, status,
// data } — a network rejection or an unparseable body can never throw, so the
// callers can clear their busy state and surface an error instead of freezing.

afterEach(() => vi.restoreAllMocks());

describe("postJson", () => {
  it("returns ok + parsed body on a 2xx response", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ startsAt: "x" }) }) as Response,
    ) as unknown as typeof fetch;

    const r = await postJson<{ startsAt?: string }>("/booking", { a: 1 });
    expect(r).toEqual({ ok: true, status: 200, data: { startsAt: "x" } });
  });

  it("returns the status and parsed body on a non-2xx response (does not throw)", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: false, status: 409, json: async () => ({ error: "taken" }) }) as Response,
    ) as unknown as typeof fetch;

    const r = await postJson<{ error?: string }>("/booking", {});
    expect(r).toEqual({ ok: false, status: 409, data: { error: "taken" } });
  });

  it("normalizes a network rejection to { ok:false, status:0, data:{} } instead of throwing", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const r = await postJson("/booking", {});
    expect(r).toEqual({ ok: false, status: 0, data: {} });
  });

  it("returns empty data when the body is not valid JSON", async () => {
    global.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    const r = await postJson("/booking", {});
    expect(r).toEqual({ ok: false, status: 500, data: {} });
  });

  it("aborts a hung request after timeoutMs and resolves the retryable error shape (#626)", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its AbortSignal fires — i.e. a wedged
    // request that would otherwise await forever.
    global.fetch = vi.fn((_url, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
    ) as unknown as typeof fetch;

    const p = postJson("/booking", {}, { timeoutMs: 20000 });
    await vi.advanceTimersByTimeAsync(20000);
    await expect(p).resolves.toEqual({ ok: false, status: 0, data: {} });
    vi.useRealTimers();
  });

  it("does not abort a request that responds before timeoutMs (#626)", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ startsAt: "x" }) }) as Response,
    ) as unknown as typeof fetch;

    const r = await postJson<{ startsAt?: string }>("/booking", {}, { timeoutMs: 20000 });
    expect(r).toEqual({ ok: true, status: 200, data: { startsAt: "x" } });
    // The abort timer must not fire against an already-settled request.
    await vi.advanceTimersByTimeAsync(20000);
    vi.useRealTimers();
  });

  it("sends a JSON content-type and stringified body", async () => {
    const fn = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({}) }) as Response,
    );
    global.fetch = fn as unknown as typeof fetch;

    await postJson("/api/x", { hello: "world" });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ hello: "world" }));
  });
});
