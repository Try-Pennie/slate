import { describe, it, expect, vi, beforeEach } from "vitest";

// #3615: the step the daily reroute drill takes inside the deployment, where Slate's own
// credentials reach the calendars. Pinned here: the canary's key and nothing else (the smoke
// family's contract), one drill at a time, the shared lease over the smoke test advisors (#4180),
// and the drill's own answer passed through untouched so the command exits on its code. The drill itself is node-tested in scripts/test-demotion-drill.ts.

const env = vi.hoisted(() => ({ bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => "") }));
vi.mock("@/lib/env", () => env);
const drill = vi.hoisted(() => ({ runDemotionDrillLive: vi.fn() }));
vi.mock("@/lib/booking/demotion-drill-live", () => drill);
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "claim"),
  releaseLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/locks", () => locks);
// #4180: the one lease over the two smoke test advisors the canary also books on.
const advisors = vi.hoisted(() => ({
  takeTestAdvisorLease: vi.fn(async (): Promise<string | null> => "advisor-claim"),
  releaseTestAdvisorLease: vi.fn(async (_token: string) => "released" as const),
}));
vi.mock("@/lib/booking/test-advisor-lease", () => advisors);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

function post(authorization = "Bearer canary-key") {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return POST(new Request("http://localhost/api/smoke/demotion-drill", { method: "POST", headers }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
    caller === "canary" && slot === "primary" ? "canary-key" : caller === "partner" && slot === "primary" ? "partner-key" : "",
  );
});

describe("POST /api/smoke/demotion-drill (#3615)", () => {
  it("runs the drill for the canary's key and answers its verdict", async () => {
    drill.runDemotionDrillLive.mockResolvedValueOnce({ reason: "passed", detail: "all good" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reason: "passed", detail: "all good" });
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("answers a failed drill as its own reason, not as an HTTP error", async () => {
    drill.runDemotionDrillLive.mockResolvedValueOnce({ reason: "did-not-move", detail: "x" });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("did-not-move");
  });

  it("refuses any other key, a partner's included, before running anything", async () => {
    for (const auth of ["Bearer partner-key", "Bearer wrong", ""]) {
      const res = await post(auth);
      expect(res.status).toBe(401);
    }
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();
  });

  it("fails closed when no canary key is configured", async () => {
    env.bookingApiKeyFor.mockReturnValue("");
    const res = await post();
    expect(res.status).toBe(503);
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();
  });

  it("runs one drill at a time, answering busy rather than running two against one advisor", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("busy");
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();
  });

  it("answers a drill that threw past its own boundary as errored, releasing the lock", async () => {
    drill.runDemotionDrillLive.mockRejectedValueOnce(new Error("bucket read failed"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "errored" });
    expect(locks.releaseLock).toHaveBeenCalled();
    expect(advisors.releaseTestAdvisorLease).toHaveBeenCalledWith("advisor-claim");
  });

  it("holds the smoke test advisors' lease for the drill and releases it after (#4180)", async () => {
    drill.runDemotionDrillLive.mockImplementationOnce(async () => {
      expect(advisors.takeTestAdvisorLease).toHaveBeenCalledTimes(1);
      expect(advisors.releaseTestAdvisorLease).not.toHaveBeenCalled();
      return { reason: "passed", detail: "ok" };
    });
    await post();
    expect(advisors.releaseTestAdvisorLease).toHaveBeenCalledWith("advisor-claim");
  });

  it("answers test-advisors-held, without running, while the canary holds the advisors (#4180)", async () => {
    advisors.takeTestAdvisorLease.mockResolvedValueOnce(null);
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("test-advisors-held");
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();
    expect(advisors.releaseTestAdvisorLease).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("never takes the advisors' lease for a second drill answered busy", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    await post();
    expect(advisors.takeTestAdvisorLease).not.toHaveBeenCalled();
  });
});
