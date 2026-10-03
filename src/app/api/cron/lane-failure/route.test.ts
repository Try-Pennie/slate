import { describe, it, expect, vi, beforeEach } from "vitest";

// #3133: where the Worker's dispatcher reports a lane that threw or answered
// non-ok. The parsing and the copy are pinned offline in
// scripts/test-cron-lane-run.ts; this is the route glue: auth first, a body it
// cannot read refused, one throttled page per lane, and a send that fails
// answered as a failure so the dispatcher logs it against the tick.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));
const logged = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/log", () => logged);

import { POST } from "./route";

function req(body: unknown, tick: string | null = "0f1e2d3c4b5a6978") {
  const headers = new Headers({ "content-type": "application/json" });
  if (tick) headers.set("x-slate-tick-id", tick);
  return new Request("https://slate.trypennie.app/api/cron/lane-failure", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/cron/lane-failure", () => {
  it("returns 401 and sends nothing without the cron bearer", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await POST(req({ lane: "outbox", status: 500, reason: "answered 500" }));
    expect(res.status).toBe(401);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once, on the lane's own key, naming the tick", async () => {
    const res = await POST(req({ lane: "outbox", status: null, reason: "fetch failed" }));
    expect(res.status).toBe(200);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = dispatch.sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("cron_lane_failed:outbox");
    expect(cooldownMs).toBeGreaterThan(0);
    expect(text).toContain("tick=0f1e2d3c4b5a6978");
  });

  it("maps a lane nothing schedules onto other, so the key family stays bounded", async () => {
    await POST(req({ lane: "made_up", status: 500, reason: "answered 500" }));
    expect(dispatch.sendThrottledAlert.mock.calls[0]![0]).toBe("cron_lane_failed:other");
  });

  it("ignores a tick header it did not mint", async () => {
    await POST(req({ lane: "sync", status: 500, reason: "answered 500" }, "<script>"));
    expect(dispatch.sendThrottledAlert.mock.calls[0]![2]).not.toContain("<script>");
  });

  it("refuses a body that is not a lane failure, and pages nothing", async () => {
    for (const body of ["not json", { lane: "outbox" }, { lane: "../x", status: 1, reason: "r" }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // The failure path: a send that throws must not answer 200, or the dispatcher
  // records nothing and a lane failure that was never paged reads as handled.
  it("answers 500 and logs it when the page cannot be sent", async () => {
    const err = new Error("cooldown unusable");
    dispatch.sendThrottledAlert.mockRejectedValueOnce(err);
    const res = await POST(req({ lane: "outbox", status: 500, reason: "answered 500" }));
    expect(res.status).toBe(500);
    expect(logged.log.error).toHaveBeenCalledTimes(1);
    expect(logged.log.error.mock.calls[0]![2]).toBe(err);
  });
});
