import { describe, it, expect, vi, beforeEach } from "vitest";

// #1564: the one step a command run from a laptop cannot take for itself. A Durable Object is
// reachable only through a binding inside the Worker, so this endpoint reports one request
// against a fixed monitor key and answers with the count the object now holds. Two calls and a
// rising count prove the counter ANSWERS, which is the half the monitor lane deliberately
// cannot prove (#1558).
//
// Two things are pinned here that nothing else can see: the auth contract (fails CLOSED with no
// key, 401 for a wrong one, same as its /api/smoke siblings), and that each way of learning
// nothing answers DIFFERENTLY, so the command exits on its own code for each (L11).

const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => ""),
  bookingApiKeySecondary: vi.fn(() => ""),
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
}));
vi.mock("@/lib/env", () => env);

const cf = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => cf);

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import { POST } from "./route";
import { BURST_PROBE_REASON, BURST_VERIFY_KEY } from "@/lib/monitor/burst-counter-probe";
import { BURST_LIMITER_BINDING } from "@/lib/rate-limit-burst";

function post(authorization = "Bearer real-key") {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return POST(new Request("http://localhost/api/smoke/burst-counter", {
    method: "POST",
    headers,
  }) as never);
}

/** A namespace whose object answers with `reply`, recording the ids it was asked for. */
function namespaceAnswering(reply: (url: string, init?: RequestInit) => Promise<Response>) {
  const asked: string[] = [];
  const ns = {
    idFromName: (name: string) => {
      asked.push(name);
      return { name };
    },
    get: () => ({ fetch: reply }),
  };
  cf.getCloudflareContext.mockReturnValue({ env: { [BURST_LIMITER_BINDING]: ns } });
  return asked;
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyPrimary.mockReturnValue("real-key");
  env.bookingApiKeySecondary.mockReturnValue("");
});

describe("POST /api/smoke/burst-counter", () => {
  it("fails CLOSED with 503 when no key is configured, and never touches the counter", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("");
    const asked = namespaceAnswering(async () => Response.json({ count: 1, windowStartMs: 0 }));
    const res = await post();
    expect(res.status).toBe(503);
    expect(asked).toEqual([]);
    expect(await res.json()).not.toHaveProperty("count");
  });

  it("401s a wrong key without reporting anything to the counter", async () => {
    const asked = namespaceAnswering(async () => Response.json({ count: 1, windowStartMs: 0 }));
    const res = await post("Bearer not-the-key");
    expect(res.status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("401s a missing authorization header", async () => {
    namespaceAnswering(async () => Response.json({ count: 1, windowStartMs: 0 }));
    const res = await post("");
    expect(res.status).toBe(401);
  });

  it("reports one request against the FIXED monitor key and answers with the count", async () => {
    const bodies: unknown[] = [];
    const asked = namespaceAnswering(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ count: 7, windowStartMs: 1_760_000_040_000 });
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reason: BURST_PROBE_REASON.counted,
      count: 7,
      windowStartMs: 1_760_000_040_000,
      key: BURST_VERIFY_KEY,
    });
    // The key is a constant, not anything the caller sent: a caller who could name it could
    // report requests against a real lead's count and push them toward a ceiling.
    expect(asked).toEqual([BURST_VERIFY_KEY]);
    expect(bodies).toEqual([{ bump: 1 }]);
  });

  it("reports an unreadable context APART from a missing binding: different remedies", async () => {
    cf.getCloudflareContext.mockImplementation(() => {
      throw new Error("no context");
    });
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe(BURST_PROBE_REASON.contextUnreadable);
  });

  it("reports a missing binding as its own reason", async () => {
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe(BURST_PROBE_REASON.bindingMissing);
  });

  it("reports an object that THREW as unreachable, and logs the error itself", async () => {
    namespaceAnswering(async () => {
      throw new Error("durable object unreachable");
    });
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe(BURST_PROBE_REASON.objectUnreachable);
    expect(body.detail).toContain("unreachable");
    // The full error goes to the logs; the reply carries a short reason (#1133).
    expect(logged.error).toHaveBeenCalled();
  });

  it("reports an object that answered with an error status as unreachable too", async () => {
    namespaceAnswering(async () => new Response("nope", { status: 500 }));
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe(BURST_PROBE_REASON.objectUnreachable);
    expect(body.detail).toContain("500");
  });

  it("refuses an answer with no count rather than defaulting it to zero", async () => {
    namespaceAnswering(async () => Response.json({ ok: true }));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe(BURST_PROBE_REASON.noCount);
  });

  it("refuses an answer with a count and no window, because a rise needs one window", async () => {
    namespaceAnswering(async () => Response.json({ count: 3 }));
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe(BURST_PROBE_REASON.noCount);
    expect(body).not.toHaveProperty("count");
  });

  it("gives every failure its own reason, so none of them can answer for another", async () => {
    const reasons: string[] = [];

    cf.getCloudflareContext.mockImplementation(() => {
      throw new Error("no context");
    });
    reasons.push((await (await post()).json()).reason);

    cf.getCloudflareContext.mockReset();
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    reasons.push((await (await post()).json()).reason);

    namespaceAnswering(async () => {
      throw new Error("boom");
    });
    reasons.push((await (await post()).json()).reason);

    namespaceAnswering(async () => Response.json({ ok: true }));
    reasons.push((await (await post()).json()).reason);

    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).not.toContain(BURST_PROBE_REASON.counted);
  });
});
