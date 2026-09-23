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
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
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
    expect(await res.json()).toEqual({ commit: "abc1234", loadtest: false, faultPct: 0 });
  });

  it("reports loadtest mode, which is how the load run's preflight refuses early", async () => {
    // #2242. The preflight asks this BEFORE it writes anything: if the deployment
    // is not in load test mode, its own control booking would be a real calendar
    // event with a real invitation sent, so it has to be able to refuse first.
    // False is the answer here and everywhere but env.loadtest, which is the
    // direction that matters (L159): a field hard wired to true would satisfy the
    // preflight over production.
    const saved = process.env.SLATE_LOADTEST;
    process.env.SLATE_LOADTEST = "true";
    try {
      env.bookingApiKeyPrimary.mockReturnValue("real-key");
      const res = await get("Bearer real-key");
      expect(await res.json()).toEqual({
        commit: "abc1234",
        loadtest: true,
        faultPct: 0,
        productionSecrets: [],
      });
    } finally {
      if (saved === undefined) delete process.env.SLATE_LOADTEST;
      else process.env.SLATE_LOADTEST = saved;
    }
  });

  it("accepts the secondary key too, so the key can be rotated without a deploy gap", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("old-key");
    env.bookingApiKeySecondary.mockReturnValue("new-key");
    const res = await get("Bearer new-key");
    expect(res.status).toBe(200);
    expect((await res.json()).commit).toBe("abc1234");
  });

  it("reports the fault percentage the stub is really injecting from", async () => {
    // #2262. The load run's fault leg asks this before it drives, because a
    // deployment that never received the setting fails no reads at all: it answers
    // every request perfectly and would satisfy the "no 5xx under fault" bar with
    // no fault having happened. Zero is the answer everywhere but a fault leg, and
    // it is what the preflight requires before a steady pass.
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect((await res.json()).faultPct).toBe(0);
  });

  it("names the production settings a load test build is carrying, so the preflight can refuse", async () => {
    // #2335. A contaminated build is pointed at the right branch and answers on the
    // right address, so every other refusal stays correctly silent. This endpoint is
    // the one that answers without touching the database, which is why it can still
    // say so while the rest of the deployment refuses itself.
    const saved = process.env.SLATE_LOADTEST;
    process.env.SLATE_LOADTEST = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-not-a-real-token";
    try {
      env.bookingApiKeyPrimary.mockReturnValue("real-key");
      const body = await (await get("Bearer real-key")).json();
      expect(body.productionSecrets).toEqual(["SLACK_BOT_TOKEN"]);
      // The NAMES, never the values: this is answered over the wire and logged.
      expect(JSON.stringify(body)).not.toContain("xoxb-not-a-real-token");
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
      if (saved === undefined) delete process.env.SLATE_LOADTEST;
      else process.env.SLATE_LOADTEST = saved;
    }
  });

  it("says nothing about its own settings when it is not a load test", async () => {
    // The direction that matters (L159): production holds every one of these by
    // design, and listing which ones it has on a reachable endpoint would be a
    // config leak dressed as a safety check. The field exists only under the flag.
    process.env.SLACK_BOT_TOKEN = "xoxb-not-a-real-token";
    try {
      env.bookingApiKeyPrimary.mockReturnValue("real-key");
      const body = await (await get("Bearer real-key")).json();
      expect(body).not.toHaveProperty("productionSecrets");
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it("returns ONLY the enumerated fields, so the endpoint cannot grow into a config leak", async () => {
    // The constraint is unchanged and the list is: a field may be here only if
    // somebody decided it may. `commit` says which build is live (#1037) and
    // `loadtest` says which mode it is in (#2242), and both are facts about the
    // deployment rather than about its configuration, and `faultPct` (#2262) says
    // whether it is injecting Google failures. Widening this list is the
    // deliberate act; a new key appearing without one fails here.
    env.bookingApiKeyPrimary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect(Object.keys(await res.json()).sort()).toEqual(["commit", "faultPct", "loadtest"]);
  });
});
