import { describe, it, expect, vi, beforeEach } from "vitest";

// #2031: the daily Slate against cal.com comparison reports here, and Slate turns
// it into an alert with a cooldown and an all clear (a GitHub runner has no memory
// of what it said yesterday, and drift is a condition rather than an event).
//
// The case worth pinning hardest is the LAST one: a sweep that compared nobody must
// settle nothing in either direction. It found no difference, so it must not page,
// and it looked at nobody, so it must not clear. An all clear hung off "we did not
// alert this run" is how a recovery notice gets posted from a query that never ran
// (#1134, #1152).

const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
}));
// #2854: the smoke endpoints take the canary's own key and nothing else, so the key
// these tests authenticate with is the canary's; a partner's key is configured
// beside it in the refusal test to prove it is refused.
const canaryKey = vi.hoisted(() => ({ primary: vi.fn(() => ""), secondary: vi.fn(() => "") }));
const canaryKeyFor = (caller: string, slot: string) =>
  caller !== "canary" ? "" : slot === "primary" ? canaryKey.primary() : canaryKey.secondary();
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => true),
}));
const settings = vi.hoisted(() => ({
  loadMonitorCooldowns: vi.fn(async () => ({ schedule_parity_drift: 86_400_000 })),
}));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/settings", () => settings);

import { POST } from "./route";

const RUN = "https://github.com/Try-Pennie/slate/actions/runs/1";

function post(body: unknown, authorization = "Bearer real-secret") {
  const headers = new Headers({ authorization, "content-type": "application/json" });
  return POST(
    new Request("http://localhost/api/smoke/schedule-parity", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyFor.mockImplementation(canaryKeyFor);
  canaryKey.primary.mockReturnValue("real-secret");
  canaryKey.secondary.mockReturnValue("");
});

describe("POST /api/smoke/schedule-parity (#2031)", () => {
  it("returns 503 and says nothing when no key is configured", async () => {
    canaryKey.primary.mockReturnValue("");
    const res = await post({ total: 1, compared: 1, findings: [], runUrl: RUN }, "Bearer anything");
    expect(res.status).toBe(503);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("returns 401 and says nothing for a wrong key", async () => {
    const res = await post({ total: 1, compared: 1, findings: [], runUrl: RUN }, "Bearer wrong");
    expect(res.status).toBe(401);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  // #2854: a partner's key is refused here, even configured beside the canary's.
  it("returns 401 and says nothing for a partner's key", async () => {
    env.bookingApiKeyFor.mockImplementation((c: string, s: string) => (c === "regal" && s === "primary" ? "regal-key" : canaryKeyFor(c, s)));
    const res = await post({ total: 1, compared: 1, findings: [], runUrl: RUN }, "Bearer regal-key");
    expect(res.status).toBe(401);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("pages on a measured difference, using the tunable cooldown", async () => {
    const res = await post({
      total: 102,
      compared: 100,
      runUrl: RUN,
      findings: [{ verdict: "days-differ", count: 6, agents: ["forellana@x"] }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "page", drifted: 6 });
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
    ];
    expect(key).toBe("schedule_parity_drift");
    expect(cooldown).toBe(86_400_000);
    expect(text).toContain("forellana@x");
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("clears when a sweep that compared agents found no difference", async () => {
    const res = await post({ total: 102, compared: 102, findings: [], runUrl: RUN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "all-clear" });
    expect(dispatch.resolveAlert).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("a standing condition alone still clears, and never pages", async () => {
    // cfrank@ and jsaminu@ hold a cal.com schedule with no windows in it. Nothing
    // will change that on its own, so paging on it would leave the check red every
    // morning forever, which is how a check stops being read (L36).
    const res = await post({
      total: 102,
      compared: 100,
      runUrl: RUN,
      findings: [{ verdict: "no-calcom-schedule", count: 2, agents: ["cfrank@x", "jsaminu@x"] }],
    });
    expect(await res.json()).toMatchObject({ action: "all-clear" });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("settles NOTHING when the sweep compared nobody", async () => {
    const res = await post({
      total: 102,
      compared: 0,
      runUrl: RUN,
      findings: [{ verdict: "calcom-unreachable", count: 102, agents: [] }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "unmeasured" });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("refuses a verdict it does not know rather than rendering it", async () => {
    const res = await post({
      total: 1,
      compared: 1,
      runUrl: RUN,
      findings: [{ verdict: "<script>", count: 1, agents: [] }],
    });
    expect(res.status).toBe(400);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("refuses a run link that does not point at GitHub", async () => {
    const res = await post({ total: 1, compared: 1, findings: [], runUrl: "https://example.com/phish" });
    expect(res.status).toBe(400);
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await post("not json at all");
    expect(res.status).toBe(400);
  });
});
