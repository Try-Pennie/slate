import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #2627: the ONE agent cal.com read the activation gate makes, so a hire's real week
// is in Slate the moment they become bookable rather than at 12:20 UTC tomorrow.
//
// Every way it can fail to produce a schedule is its OWN answer, because the gate
// logs each by name and "no cal.com account", "cal.com is rate limiting us" and
// "cal.com changed shape" send three different people to do three different things
// (L11). None of them may throw: the caller must be able to activate regardless.
const env = vi.hoisted(() => ({ orgId: "19474", apiKey: "key-1", loadtest: false }));

vi.mock("@/lib/env", () => ({
  calcomOrgId: () => env.orgId,
  calcomApiKey: () => env.apiKey,
  calcomBaseUrl: () => "https://api.cal.com/v2",
}));
vi.mock("@/lib/loadtest-guard", () => ({
  isLoadtest: () => env.loadtest,
  loadtestRefusal: (s: string) => `load test refused ${s}`,
  refuseUnderLoadtest: (s: string) => {
    if (env.loadtest) throw new Error(`load test refused ${s}`);
  },
}));

import { readScheduleForImport } from "./client";

type Reply = { status: number; data?: unknown } | "throw";
let replies: Reply[] = [];
let calls: { url: string; headers: Record<string, string>; signal: unknown }[] = [];

const NSHORT = {
  id: 9,
  timeZone: "America/Los_Angeles",
  isDefault: true,
  availability: [{ days: ["Monday"], startTime: "07:00", endTime: "16:00" }],
};

beforeEach(() => {
  env.orgId = "19474";
  env.apiKey = "key-1";
  env.loadtest = false;
  replies = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; signal?: unknown }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {}, signal: init?.signal });
      const next = replies.shift() ?? { status: 500 };
      if (next === "throw") throw new Error("socket hang up");
      return { status: next.status, json: async () => ({ data: next.data }) } as unknown as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const read = () => readScheduleForImport("nshort@trypennie.com", 2_000);

describe("readScheduleForImport (#2627)", () => {
  it("finds the user by email and returns their default schedule in two calls", async () => {
    replies = [
      { status: 200, data: [{ id: 42, email: "NShort@trypennie.com" }] },
      { status: 200, data: [{ id: 1, isDefault: false }, NSHORT] },
    ];
    const r = await read();
    expect(r).toEqual({ kind: "schedule", schedule: NSHORT });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      "https://api.cal.com/v2/organizations/19474/users?emails[]=nshort%40trypennie.com",
    );
    expect(calls[1].url).toBe("https://api.cal.com/v2/organizations/19474/users/42/schedules");
    // The importer's measured version, on both, and every call carries a deadline.
    for (const c of calls) {
      expect(c.headers["cal-api-version"]).toBe("2024-09-04");
      expect(c.signal).toBeDefined();
    }
  });

  it("an address cal.com does not know is no-account, and reads nothing more", async () => {
    replies = [{ status: 200, data: [] }];
    expect(await read()).toEqual({ kind: "no-account" });
    expect(calls).toHaveLength(1);
  });

  it("a listed user whose email is not the one asked for is refused, never used", async () => {
    // L75: acting on a neighbouring candidate would import somebody else's week.
    replies = [{ status: 200, data: [{ id: 42, email: "someone-else@trypennie.com" }] }];
    const r = await read();
    expect(r.kind).toBe("unreadable");
    expect(calls).toHaveLength(1);
  });

  it("an account with no schedule is no-schedule", async () => {
    replies = [
      { status: 200, data: [{ id: 42, email: "nshort@trypennie.com" }] },
      { status: 200, data: [] },
    ];
    expect(await read()).toEqual({ kind: "no-schedule" });
  });

  it("a 429 on either call is rate-limited and is NOT retried", async () => {
    replies = [{ status: 429 }];
    expect(await read()).toEqual({ kind: "rate-limited" });
    expect(calls).toHaveLength(1);

    calls = [];
    replies = [{ status: 200, data: [{ id: 42, email: "nshort@trypennie.com" }] }, { status: 429 }];
    expect(await read()).toEqual({ kind: "rate-limited" });
    expect(calls).toHaveLength(2);
  });

  it("any other status is refused and names it", async () => {
    replies = [{ status: 401 }];
    expect(await read()).toEqual({ kind: "refused", status: 401 });
    replies = [{ status: 200, data: [{ id: 42, email: "nshort@trypennie.com" }] }, { status: 503 }];
    expect(await read()).toEqual({ kind: "refused", status: 503 });
  });

  it("a thrown fetch (a timeout, a dropped socket) is unreachable, never a throw", async () => {
    replies = ["throw"];
    const r = await read();
    expect(r.kind).toBe("unreachable");
  });

  it("a payload that is not a list is unreadable, apart from absent", async () => {
    replies = [{ status: 200, data: { not: "a list" } }];
    expect((await read()).kind).toBe("unreadable");
    replies = [
      { status: 200, data: [{ id: 42, email: "nshort@trypennie.com" }] },
      { status: 200, data: "nope" },
    ];
    expect((await read()).kind).toBe("unreadable");
  });

  it("an unconfigured deployment and a load test make no call at all", async () => {
    env.apiKey = "";
    expect(await read()).toEqual({ kind: "not-configured" });
    env.apiKey = "key-1";
    env.loadtest = true;
    expect(await read()).toEqual({ kind: "loadtest" });
    expect(calls).toHaveLength(0);
  });
});
