import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallMeNowDeps } from "@/lib/salesforce/call-me-now";
import { SfHttpError } from "@/lib/salesforce/rest";

// The Call me now endpoint the inline booker calls (#3718). The decision itself is
// pinned in scripts/test-call-me-now.ts; this pins the route glue around the REAL
// decision on fake Salesforce reads and writes:
//  - the limiter runs first and a refusal reaches Salesforce not at all;
//  - "check" never writes, and answers only offered or not;
//  - a refusal answers WHY nowhere, so a guessed lead id cannot tell a missing lead
//    from a contact that did not match, and offers no retry;
//  - a failure answers 503 with retry, and pages after the response.

const rateLimit = vi.hoisted(() => ({
  callMeNowAllowed: vi.fn(async (_ip: string) => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const live = vi.hoisted(() => ({ deps: null as unknown as CallMeNowDeps, writes: [] as string[], forget: vi.fn() }));
const notify = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async (_k: string, _ms: number, _t: string) => {}) }));
const deferred = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));

vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/salesforce/call-me-now-live", () => ({
  liveCallMeNowDeps: () => live.deps,
  forgetCallMeNowLogin: live.forget,
}));
vi.mock("@/lib/notify/dispatch", () => notify);
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_ctx: string, work: () => Promise<unknown>) => {
    deferred.jobs.push(work);
  },
}));

import { POST } from "./route";

const LEAD = "00QUi000010889ZMAQ";
const ON = { isActiveAlternate: true, pageAlternate: "Call Me Now Button", minimumAdv: 1 };

function call(body: unknown, ip = "203.0.113.7") {
  return POST(
    new Request("http://localhost/api/call-me-now", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "cf-connecting-ip": ip }),
      body: JSON.stringify(body),
    }) as never,
  );
}
const press = (over: Record<string, unknown> = {}) => call({ action: "request", leadId: LEAD, email: "maria@example.com", ...over });
const check = (over: Record<string, unknown> = {}) => call({ action: "check", leadId: LEAD, email: "maria@example.com", ...over });

async function runDeferred() {
  for (const job of deferred.jobs.splice(0)) await job();
}

beforeEach(() => {
  rateLimit.callMeNowAllowed.mockReset().mockResolvedValue(true);
  notify.sendThrottledAlert.mockClear();
  deferred.jobs.length = 0;
  live.writes = [];
  live.forget.mockClear();
  live.deps = {
    readLead: async () => ({ email: "maria@example.com", phones: [], adv: 3, pending: false }),
    readSwitch: async () => ON,
    writeRequested: async (id) => {
      live.writes.push(id);
    },
  };
});

describe("POST /api/call-me-now (#3718)", () => {
  it("marks a matching, eligible lead for a call", async () => {
    const res = await press();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "requested" });
    expect(live.writes).toEqual([LEAD]);
    expect(live.forget).not.toHaveBeenCalled();
  });

  it("refuses over the limit before Salesforce is asked", async () => {
    rateLimit.callMeNowAllowed.mockResolvedValue(false);
    let reads = 0;
    live.deps.readLead = async () => (reads++, null);
    const res = await press();
    expect(res.status).toBe(429);
    expect(reads).toBe(0);
    expect(live.writes).toEqual([]);
  });

  it("checking writes nothing and answers only whether the button shows", async () => {
    const res = await check();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offered: true });
    expect(live.writes).toEqual([]);
  });

  it("a check that fails hides the button rather than erroring the card", async () => {
    live.deps.readSwitch = async () => {
      throw new Error("SF query failed: 503");
    };
    const res = await check();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offered: false });
    // A Salesforce outage hides the button for every lead, and then nobody can press
    // it to cause the other page, so the check must page on its own (L10, L11).
    await runDeferred();
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , page] = notify.sendThrottledAlert.mock.calls[0]!;
    // Its own key, so a hidden button never silences the page about a lead who pressed.
    expect(key).toBe("call_me_now_hidden");
    expect(page).toMatch(/button was hidden/i);
    expect(live.forget).not.toHaveBeenCalled();
  });

  it("a check that is simply refused pages nothing", async () => {
    live.deps.readSwitch = async () => ({ ...ON, isActiveAlternate: false });
    expect(await (await check()).json()).toEqual({ offered: false });
    await runDeferred();
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // A refusal is only meaningful beside a success, so this test also presses for the
  // matching lead first: a route that refused everything would fail here, not pass.
  it("a missing lead and a mismatched contact get the same answer, with no retry and no write", async () => {
    expect(await (await press()).json()).toEqual({ outcome: "requested" });
    live.writes = [];
    live.deps.readLead = async () => null;
    const noLead = await (await press()).json();
    live.deps.readLead = async () => ({ email: "someone@else.com", phones: [], adv: 3, pending: false });
    const mismatch = await (await press()).json();
    expect(noLead).toEqual({ outcome: "refused", retry: false });
    expect(mismatch).toEqual(noLead);
    expect(live.writes).toEqual([]);
  });

  it("a lead with a call already pending is told so, with no second write", async () => {
    live.deps.readLead = async () => ({ email: "maria@example.com", phones: [], adv: 3, pending: true });
    expect(await (await press()).json()).toEqual({ outcome: "already-requested" });
    expect(live.writes).toEqual([]);
  });

  it("a failed write answers 503 with retry and pages after the response", async () => {
    live.deps.writeRequested = async () => {
      throw new Error("SF update failed: 503");
    };
    const res = await press();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ outcome: "failed", retry: true });
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
    await runDeferred();
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = notify.sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("call_me_now_failed");
    expect(text).toContain(LEAD);
    // A 503 is Salesforce down, not the login refused: dropping the login here would
    // log in afresh on every card load for the whole outage.
    expect(live.forget).not.toHaveBeenCalled();
  });

  it("drops the kept login only when Salesforce refuses it", async () => {
    live.deps.writeRequested = async () => {
      throw new SfHttpError("SF update failed: 401 INVALID_SESSION_ID", 401);
    };
    expect((await press()).status).toBe(503);
    expect(live.forget).toHaveBeenCalledTimes(1);
  });

  it("refuses a request with no action or no lead id", async () => {
    expect((await call({ leadId: LEAD })).status).toBe(400);
    expect((await call({ action: "request" })).status).toBe(400);
    expect((await call({ action: "delete", leadId: LEAD })).status).toBe(400);
  });
});
