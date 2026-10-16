import { describe, it, expect, vi, beforeEach } from "vitest";

// #1037: the post-deploy probe reads this to confirm the live Worker is serving the
// commit that was just deployed, before judging its health.
//
// It is key-authed on purpose. The running commit tells anyone probing the app
// which build is live and therefore which known issues to try, so it must never be
// readable without the booking key. Same contract as /api/smoke/heartbeat: fails
// CLOSED (503) when no key is configured, 401 for a wrong or missing key.

const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => ""),
}));
// #2854: the smoke endpoints take the canary's own key and nothing else, so the key
// these tests authenticate with is the canary's; a partner's key is configured
// beside it in the refusal test to prove it is refused.
const canaryKey = vi.hoisted(() => ({ primary: vi.fn(() => ""), secondary: vi.fn(() => "") }));
const canaryKeyFor = (caller: string, slot: string) =>
  caller !== "canary" ? "" : slot === "primary" ? canaryKey.primary() : canaryKey.secondary();
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/build-info", () => ({ BUILD_COMMIT: "abc1234" }));
// #3429: the confirm crowd rule the deployment declares, read through the module so a
// case can flip it and prove the route reports the constant rather than a literal.
const crowd = vi.hoisted(() => ({ rule: "stops" as "stops" | "walks" }));
vi.mock("@/lib/confirm-crowd-rule", () => ({
  get CONFIRM_CROWD_RULE() {
    return crowd.rule;
  },
}));

import { GET } from "./route";

function get(authorization?: string) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return GET(new Request("http://localhost/api/smoke/version", { headers }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.bookingApiKeyFor.mockImplementation(canaryKeyFor);
  canaryKey.primary.mockReturnValue("");
  canaryKey.secondary.mockReturnValue("");
  crowd.rule = "stops";
});

describe("GET /api/smoke/version", () => {
  it("fails CLOSED with 503 when no key is configured, and reveals nothing", async () => {
    const res = await get("Bearer anything");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).not.toHaveProperty("commit");
  });

  it("401s a missing authorization header without revealing the commit", async () => {
    canaryKey.primary.mockReturnValue("real-key");
    const res = await get();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("abc1234");
  });

  it("401s a wrong key without revealing the commit", async () => {
    canaryKey.primary.mockReturnValue("real-key");
    const res = await get("Bearer not-the-key");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("abc1234");
  });

  // #2854: a partner's key is refused here, even configured beside the canary's.
  it("401s a partner's key without revealing the commit", async () => {
    canaryKey.primary.mockReturnValue("real-key");
    env.bookingApiKeyFor.mockImplementation((c: string, s: string) => (c === "regal" && s === "primary" ? "regal-key" : canaryKeyFor(c, s)));
    const res = await get("Bearer regal-key");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("abc1234");
  });

  it("returns the build commit to a correctly-keyed caller", async () => {
    canaryKey.primary.mockReturnValue("real-key");
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
      canaryKey.primary.mockReturnValue("real-key");
      const res = await get("Bearer real-key");
      expect(await res.json()).toEqual({
        commit: "abc1234",
        loadtest: true,
        faultPct: 0,
        faultTargets: ["google-read"],
        faultTargetsUnknown: [],
        productionSecrets: [],
        // #3258: the post confirm recompute arm, on when nothing set it.
        postConfirmRecompute: "on",
        postConfirmRecomputeUnknown: null,
        // #3490: the Google stand in's delay, off when nothing set it.
        googleDelay: "",
        googleDelayUnknown: null,
        // #3429: what a confirm waiting behind a leader that booked its rung's last
        // advisor does, which the load run's drop burst is held to.
        confirmCrowdRule: "stops",
      });
    } finally {
      if (saved === undefined) delete process.env.SLATE_LOADTEST;
      else process.env.SLATE_LOADTEST = saved;
    }
  });

  it("accepts the secondary key too, so the key can be rotated without a deploy gap", async () => {
    canaryKey.primary.mockReturnValue("old-key");
    canaryKey.secondary.mockReturnValue("new-key");
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
    canaryKey.primary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect((await res.json()).faultPct).toBe(0);
  });

  it("reports WHICH systems a load test build faults, from the constant the injectors read", async () => {
    // #3104. The fault leg's driver compares this against the targets it was asked
    // for and refuses before driving on a mismatch, so a pass that meant to fail the
    // database and is failing only Google can never be judged as if it had. Unset is
    // the original read only switch, and it is reported as that rather than as
    // nothing, because "nothing" would read as a deployment faulting no system.
    const saved = process.env.SLATE_LOADTEST;
    process.env.SLATE_LOADTEST = "true";
    try {
      canaryKey.primary.mockReturnValue("real-key");
      const body = await (await get("Bearer real-key")).json();
      expect(body.faultTargets).toEqual(["google-read"]);
      expect(body.faultTargetsUnknown).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.SLATE_LOADTEST;
      else process.env.SLATE_LOADTEST = saved;
    }
  });

  it("says nothing about fault targets when it is not a load test", async () => {
    canaryKey.primary.mockReturnValue("real-key");
    const body = await (await get("Bearer real-key")).json();
    expect(body).not.toHaveProperty("faultTargets");
    expect(body).not.toHaveProperty("faultTargetsUnknown");
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
      canaryKey.primary.mockReturnValue("real-key");
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
      canaryKey.primary.mockReturnValue("real-key");
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
    canaryKey.primary.mockReturnValue("real-key");
    const res = await get("Bearer real-key");
    expect(Object.keys(await res.json()).sort()).toEqual(["commit", "faultPct", "loadtest"]);
  });

  // #3258: which post confirm recompute arm the deployment runs, so the load run's
  // preflight can refuse a deployment running an arm nobody dispatched.
  describe("the post confirm recompute arm", () => {
    const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
      const keys = Object.keys(vars);
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      for (const k of keys) {
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
      }
      try {
        await run();
      } finally {
        for (const k of keys) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    };

    it("reports the arm the booking path acts on", async () => {
      await withEnv({ SLATE_LOADTEST: "true", SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE: "reads-only" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body.postConfirmRecompute).toBe("reads-only");
        expect(body.postConfirmRecomputeUnknown).toBeNull();
      });
    });

    it("reports a value that names no arm, and the on it runs instead", async () => {
      await withEnv({ SLATE_LOADTEST: "true", SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE: "of" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body.postConfirmRecompute).toBe("on");
        expect(body.postConfirmRecomputeUnknown).toBe("of");
      });
    });

    it("says nothing about it when it is not a load test, even with the variable set", async () => {
      await withEnv({ SLATE_LOADTEST: undefined, SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE: "off" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body).not.toHaveProperty("postConfirmRecompute");
        expect(body).not.toHaveProperty("postConfirmRecomputeUnknown");
      });
    });

    // #3490: which Google delay the stand in takes, from the same parser the stand in
    // acts on, so the preflight can refuse a deployment whose rig nobody dispatched.
    it("reports the Google delay the stand in takes, in its canonical spelling", async () => {
      await withEnv({ SLATE_LOADTEST: "true", SLATE_LOADTEST_GOOGLE_DELAY: " write=5000/8000 , read=3000/5000" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body.googleDelay).toBe("read=3000/5000,write=5000/8000");
        expect(body.googleDelayUnknown).toBeNull();
      });
    });

    it("reports a Google delay that did not parse, and the nothing it delays instead", async () => {
      await withEnv({ SLATE_LOADTEST: "true", SLATE_LOADTEST_GOOGLE_DELAY: "read=3s/5s" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body.googleDelay).toBe("");
        expect(body.googleDelayUnknown).toBe("read=3s/5s");
      });
    });

    it("says nothing about the Google delay when it is not a load test, even with it set", async () => {
      await withEnv({ SLATE_LOADTEST: undefined, SLATE_LOADTEST_GOOGLE_DELAY: "read=3000/5000" }, async () => {
        canaryKey.primary.mockReturnValue("real-key");
        const body = await (await get("Bearer real-key")).json();
        expect(body).not.toHaveProperty("googleDelay");
        expect(body).not.toHaveProperty("googleDelayUnknown");
      });
    });
  });

  // #3429: whether a confirm in a crowd behind a leader that booked its rung's last
  // advisor walks the tier ladder (#3338, built in #3437) or is answered SLOT_TAKEN.
  // The load run's drop burst is held to whichever rule the deployment SAYS it runs,
  // so a run before #3437 merges is neither failed for #3338 nor passed by a bar that
  // never asked.
  describe("the confirm crowd rule", () => {
    const withLoadtest = async (run: () => Promise<void>) => {
      const saved = process.env.SLATE_LOADTEST;
      process.env.SLATE_LOADTEST = "true";
      try {
        await run();
      } finally {
        if (saved === undefined) delete process.env.SLATE_LOADTEST;
        else process.env.SLATE_LOADTEST = saved;
      }
    };

    it("reports the rule from the constant the booking path declares, either value", async () => {
      // Both values, so a route hard wired to one of them fails here (L1).
      for (const rule of ["stops", "walks"] as const) {
        crowd.rule = rule;
        await withLoadtest(async () => {
          canaryKey.primary.mockReturnValue("real-key");
          const body = await (await get("Bearer real-key")).json();
          expect(body.confirmCrowdRule).toBe(rule);
        });
      }
    });

    it("says nothing about it when it is not a load test", async () => {
      canaryKey.primary.mockReturnValue("real-key");
      const body = await (await get("Bearer real-key")).json();
      expect(body).not.toHaveProperty("confirmCrowdRule");
    });
  });
});
