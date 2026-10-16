import { describe, it, expect, vi, beforeEach } from "vitest";

// #3801: the smoke canary hands its run outcome here so its failure posts through
// the alert throttle. The dispatcher is mocked: what the route ASKS for is pinned
// here, and what the throttle then does is driven end to end, on a pinned clock, by
// src/lib/notify/daily-repeat.test.ts.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_k: string, _ms: number, _t: string, opts?: { onOutcome?: (o: string) => void }) => {
      opts?.onOutcome?.("sent");
    },
  ),
  resolveRecovered: vi.fn(async (r: { key: string }[]) => r.map((x) => x.key)),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  bookingApiKeyFor: (caller: string, slot: string) =>
    slot !== "primary" ? "" : caller === "canary" ? "canary-secret" : `${caller}-secret`,
}));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  bearerFailureWithinLimit: async () => true,
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const call = (body: unknown, auth = "Bearer canary-secret") =>
  POST(
    new Request("http://localhost/api/smoke/failure", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );

const FAILED = {
  outcome: "failed",
  mode: "dry",
  text: "Booking canary failed: one check.\n- availability read took 4210ms\nhttps://example.com/runs/1",
  checks: ["availability read took 4210ms"],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/smoke/failure (#3801)", () => {
  it("posts a failure on its pass's key with the checks, numbers stripped, as subjects", async () => {
    const res = await call(FAILED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "sent" });
    const [key, ms, text, opts] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(key).toBe("smoke_canary_failed:dry");
    expect(ms).toBe(24 * 60 * 60_000);
    expect(text).toBe(FAILED.text);
    expect((opts as { subjects: string[] }).subjects).toEqual(["availability read took #"]);
    // A failure never announces a recovery.
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
  });

  it("answers held when the throttle held it, which tells the workflow not to post", async () => {
    dispatch.sendThrottledAlert.mockImplementationOnce(async (_k, _ms, _t, opts) => opts?.onOutcome?.("held"));
    expect(await (await call(FAILED)).json()).toEqual({ ok: true, outcome: "held" });
  });

  it("a send that throws answers 500, so the workflow posts directly", async () => {
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("alert_state unreachable"));
    const res = await call(FAILED);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("failed");
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
  });

  it("a clean dry run clears only the dry failure; a clean full run clears both", async () => {
    await call({ outcome: "passed", mode: "dry" });
    expect(dispatch.resolveRecovered.mock.calls[0][0].map((r) => r.key)).toEqual(["smoke_canary_failed:dry"]);
    await call({ outcome: "passed", mode: "full" });
    expect(dispatch.resolveRecovered.mock.calls[1][0].map((r) => r.key)).toEqual([
      "smoke_canary_failed:dry",
      "smoke_canary_failed:full",
    ]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("refuses a partner's key, and neither posts nor clears", async () => {
    const res = await call({ outcome: "passed", mode: "full" }, "Bearer regal-secret");
    expect(res.status).toBe(401);
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("refuses an unreadable body, and neither posts nor clears", async () => {
    for (const body of [
      null,
      { outcome: "passed", mode: "weekly" },
      { outcome: "failed", mode: "dry" },
      { outcome: "failed", mode: "dry", text: "x".repeat(5000), checks: [] },
      { outcome: "failed", mode: "dry", text: "x", checks: [42] },
      { outcome: "maybe", mode: "dry" },
    ]) {
      expect((await call(body)).status).toBe(400);
    }
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });
});
