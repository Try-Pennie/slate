import { describe, it, expect, vi, beforeEach } from "vitest";

// #4180: the smoke canary's handle on the one lease over the two smoke test advisors, so its
// booking checks and the daily reroute drill never book on them at once. Pinned here: the
// canary's key and nothing else (the smoke family's contract), what each answer means, and
// that a release needs the token it was given. The lease's own behaviour, against the real lock
// code and the drill's endpoint, is src/lib/booking/test-advisor-lease.test.ts.

const env = vi.hoisted(() => ({ bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => "") }));
vi.mock("@/lib/env", () => env);
const lease = vi.hoisted(() => ({
  takeTestAdvisorLease: vi.fn(async (): Promise<string | null> => "2026-10-23T15:34:00.000Z"),
  releaseTestAdvisorLease: vi.fn(async (_token: string): Promise<"released" | "not-held" | "refused"> => "released"),
}));
vi.mock("@/lib/booking/test-advisor-lease", () => lease);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST, DELETE } from "./route";

function take(authorization = "Bearer canary-key") {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return POST(new Request("http://localhost/api/smoke/test-advisor-lease", { method: "POST", headers }) as never);
}
function release(body: unknown, authorization = "Bearer canary-key") {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return DELETE(
    new Request("http://localhost/api/smoke/test-advisor-lease", {
      method: "DELETE",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
    caller === "canary" && slot === "primary" ? "canary-key" : caller === "partner" && slot === "primary" ? "partner-key" : "",
  );
});

describe("POST /api/smoke/test-advisor-lease (#4180)", () => {
  it("takes the lease for the canary's key and answers its token", async () => {
    const res = await take();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "held", token: "2026-10-23T15:34:00.000Z" });
  });

  it("answers busy when another run holds the advisors", async () => {
    lease.takeTestAdvisorLease.mockResolvedValueOnce(null);
    const res = await take();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "busy" });
  });

  it("refuses any other key, a partner's included, before touching the lease", async () => {
    for (const auth of ["Bearer partner-key", "Bearer wrong", ""]) {
      expect((await take(auth)).status).toBe(401);
      expect((await release({ token: "t" }, auth)).status).toBe(401);
    }
    expect(lease.takeTestAdvisorLease).not.toHaveBeenCalled();
    expect(lease.releaseTestAdvisorLease).not.toHaveBeenCalled();
  });

  it("fails closed when no canary key is configured", async () => {
    env.bookingApiKeyFor.mockReturnValue("");
    expect((await take()).status).toBe(503);
    expect((await release({ token: "t" })).status).toBe(503);
    expect(lease.takeTestAdvisorLease).not.toHaveBeenCalled();
  });

  it("answers a lease that could not be taken at all as an error, never as held or busy", async () => {
    lease.takeTestAdvisorLease.mockRejectedValueOnce(new Error("db down"));
    const res = await take();
    expect(res.status).toBe(500);
    expect((await res.json()).outcome).toBe("errored");
  });
});

describe("DELETE /api/smoke/test-advisor-lease (#4180)", () => {
  it("releases the claim the token names", async () => {
    const res = await release({ token: "2026-10-23T15:34:00.000Z" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "released" });
    expect(lease.releaseTestAdvisorLease).toHaveBeenCalledWith("2026-10-23T15:34:00.000Z");
  });

  it("answers not-held for a claim already gone, so a second release is harmless", async () => {
    lease.releaseTestAdvisorLease.mockResolvedValueOnce("not-held");
    const res = await release({ token: "2026-10-23T15:34:00.000Z" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "not-held" });
  });

  it("answers a release the database refused as its own failure", async () => {
    lease.releaseTestAdvisorLease.mockResolvedValueOnce("refused");
    const res = await release({ token: "2026-10-23T15:34:00.000Z" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outcome: "refused" });
  });

  it("refuses a release with no token, or one that is not a claim instant", async () => {
    for (const body of [{}, { token: "" }, { token: 7 }, { token: "not a time" }, "not json"]) {
      expect((await release(body)).status).toBe(400);
    }
    expect(lease.releaseTestAdvisorLease).not.toHaveBeenCalled();
  });
});
