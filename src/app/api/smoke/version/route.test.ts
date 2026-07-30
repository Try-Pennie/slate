import { describe, it, expect, vi, beforeEach } from "vitest";

// #1037: the post-deploy probe reads this to confirm the live Worker is serving the
// commit that was just deployed, before judging its health.
//
// It is key-authed on purpose. The running commit tells anyone probing the app
// which build is live and therefore which known issues to try, so it must never be
// readable without the booking key. Same contract as /api/smoke/heartbeat: fails
// CLOSED (503) when no key is configured, 401 for a wrong or missing key.

const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => ""),
  bookingApiKeySecondary: vi.fn(() => ""),
}));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/build-info", () => ({ BUILD_COMMIT: "abc1234" }));

import { GET } from "./route";

function get(authorization?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return GET(new Request("http://localhost/api/smoke/version", { headers }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyPrimary.mockReturnValue("");
  env.bookingApiKeySecondary.mockReturnValue("");
});

describe("GET /api/smoke/version", () => {
  it("fails CLOSED with 503 when no key is configured, and reveals nothing", async () => {
    const res = await get("Bearer anything");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).not.toHaveProperty("commit");
  });

  it("401s a missing authorization header without revealing the commit", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("abc1234");
  });

  it("401s a wrong key without revealing the commit", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get("Bearer not-the-key");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("abc1234");
  });

  it("returns the build commit to a correctly-keyed caller", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commit: "abc1234" });
  });

  it("accepts the secondary key too, so the key can be rotated without a deploy gap", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("old-key");
    env.bookingApiKeySecondary.mockReturnValue("new-key");
    const res = await get("Bearer new-key");
    expect(res.status).toBe(200);
    expect((await res.json()).commit).toBe("abc1234");
  });

  it("returns ONLY the commit, so the endpoint cannot grow into a config leak", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect(Object.keys(await res.json())).toEqual(["commit"]);
  });
});
