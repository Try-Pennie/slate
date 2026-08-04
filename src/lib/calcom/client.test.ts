import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// What the cal.com dual-write REPORTS, which is what a person reads mid-incident
// and what any retry has to act on (#1250, #1249).
//
// Two distinct things must never collapse into one answer:
//   - cal.com answered and genuinely has no such user. Nobody can book them there,
//     so there is no availability to block and nothing for anyone to do: a SKIP.
//   - the call failed (a rotated key, a 500, a changed response shape). The
//     integration is broken and the override did not land: a FAILURE, and the
//     message must name the cause it actually measured.
//
// Reporting the second as "no cal.com user for <email>" sends the reader looking
// for a missing person instead of a broken integration, and a retry built on it
// would re-attempt writes that can never succeed.
const env = vi.hoisted(() => ({
  orgId: "19474",
  apiKey: "key-1",
  baseUrl: "https://api.cal.com/v2",
}));

vi.mock("@/lib/env", () => ({
  calcomOrgId: () => env.orgId,
  calcomApiKey: () => env.apiKey,
  calcomBaseUrl: () => env.baseUrl,
}));

import { addOooOverrides } from "./client";

/** One queued response per fetch call, in order. */
type Reply = { status: number; data?: unknown };
let replies: Reply[] = [];
let urls: string[] = [];

const SCHEDULE = {
  id: 55,
  name: "Working Hours",
  timeZone: "America/New_York",
  isDefault: true,
  availability: [{ days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" }],
  overrides: [],
};

beforeEach(() => {
  env.orgId = "19474";
  env.apiKey = "key-1";
  replies = [];
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      const next = replies.shift() ?? { status: 500 };
      return {
        status: next.status,
        json: async () => ({ data: next.data }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = () => addOooOverrides("agent@trypennie.com", "2026-08-07T13:00:00Z", "2026-08-07T21:00:00Z");

describe("cal.com override outcome: absent versus failed (#1250, #1249)", () => {
  it("reports a genuinely absent user as a skip, not a failure", async () => {
    replies = [{ status: 200, data: [] }]; // cal.com answered: nobody by that email
    const outcome = await run();
    expect(outcome).toMatch(/^skipped/);
    expect(outcome).not.toMatch(/^failed/);
  });

  it("reports an expired or rotated key as a failure naming the status", async () => {
    replies = [{ status: 401 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("401");
    // The dangerous message: it asserts a cause the code never measured.
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a cal.com server error as a failure naming the status", async () => {
    replies = [{ status: 500 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("500");
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a changed response shape as a failure, not as every agent missing", async () => {
    // If cal.com stops returning a bare array, EVERY lookup would otherwise read
    // as "this person does not exist" and every approval would page a false cause.
    replies = [{ status: 200, data: { users: [{ id: 7 }] } }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).not.toContain("no cal.com user");
  });

  it("reports a failing schedule lookup as a failure naming the status", async () => {
    // The same collapse one call later: this is a class of two sites, not one.
    replies = [{ status: 200, data: [{ id: 7 }] }, { status: 403 }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("403");
    expect(outcome).not.toMatch(/no schedule for/);
  });

  it("still reports a real user who has no schedule as a failure", async () => {
    // Distinct from the cases above: cal.com answered, the user exists, and there
    // genuinely is no schedule to patch. Someone can fix that, so it stays a failure.
    replies = [{ status: 200, data: [{ id: 7 }] }, { status: 200, data: [] }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
  });

  it("skips rather than fails when cal.com is not configured", async () => {
    env.orgId = "";
    env.apiKey = "";
    const outcome = await run();
    expect(outcome).toMatch(/^skipped/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a transient server error and succeeds on the second attempt", async () => {
    // The failure that actually consumed the protection in June was a 500 on the
    // patch. A 500 is transient and very likely succeeds seconds later, so the
    // override should land rather than depend on someone reading a Slack message.
    replies = [
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 500 }, // patch fails
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} }, // patch succeeds
    ];
    const outcome = await run();
    expect(outcome).toBe("ok");
  });

  it("retries a rate limit", async () => {
    replies = [
      { status: 429 },
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} },
    ];
    expect(await run()).toBe("ok");
  });

  it("does NOT retry a rejected key, because a second attempt cannot succeed", async () => {
    replies = [{ status: 401 }, { status: 200, data: [{ id: 7 }] }];
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("401");
    // One attempt only: burning retries on a permanent failure just delays the
    // report and hammers a system that is already refusing us.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a genuinely absent user", async () => {
    replies = [{ status: 200, data: [] }];
    expect(await run()).toMatch(/^skipped/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts and reports the last cause", async () => {
    replies = Array.from({ length: 20 }, () => ({ status: 503 }));
    const outcome = await run();
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("503");
    // Bounded: the approval is a person waiting on a click, not a background job.
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("returns ok when the override patch succeeds", async () => {
    replies = [
      { status: 200, data: [{ id: 7 }] },
      { status: 200, data: [SCHEDULE] },
      { status: 200, data: {} },
    ];
    const outcome = await run();
    expect(outcome).toBe("ok");
    expect(urls.at(-1)).toContain("/schedules/55");
  });
});
