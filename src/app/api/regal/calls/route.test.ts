import { describe, it, expect, vi, beforeEach } from "vitest";

// #2090: Regal's reporting webhook posts every completed call here. Three things
// this route owes the sender and the detector behind it:
//
//  - auth through the one shared constant time verifier, refused BY NAME with a
//    503 when the secret is unset rather than accepting unauthenticated posts, and
//    a 401 on a wrong key, with nothing recorded for either;
//  - an answer inside Regal's five second budget: Regal drops an event it has no
//    reply to and does not retry, so the work goes into after() and the reply
//    never waits on the database;
//  - an unreadable body is refused without throwing (a 500 reads as retriable to
//    most senders) and is still COUNTED, because a feed whose bodies stopped being
//    readable must not look like a quiet one.

const env = vi.hoisted(() => ({ regalInboundKey: vi.fn(() => "inbound-secret"), regalInboundKey2: vi.fn(() => "") }));
vi.mock("@/lib/env", () => env);

// #2944: one delivery writes two rows, each in its own failure boundary, and
// recordRegalCall hands back each half settled rather than throwing.
const recorded = vi.hoisted(() => ({
  bodies: [] as unknown[],
  fail: false,
  duplicate: false,
  outcome: { ok: true, value: { status: "stored", eventId: "e1" } } as unknown,
  throwAll: false,
}));
vi.mock("@/lib/regal/call-store", () => ({
  recordRegalCall: vi.fn(async (body: unknown) => {
    recorded.bodies.push(body);
    if (recorded.throwAll) throw new Error("everything refused");
    const detector = recorded.fail
      ? { ok: false, error: new Error("insert refused") }
      : {
          ok: true,
          value: recorded.duplicate
            ? { status: "duplicate", eventId: "e1" }
            : { status: "recorded", reason: "candidate" },
        };
    return { detector, outcome: recorded.outcome };
  }),
}));

// after() is captured rather than run, so a test can prove the reply went out
// BEFORE any recording work happened, then run the deferred work itself.
const deferred = vi.hoisted(() => ({ jobs: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb: () => unknown) => {
      deferred.jobs.push(cb);
    }),
  };
});

const logError = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: logWarn, info: logInfo } }));
// A refused credential with no client address is reported by the rate limiter, and
// since #3145 that page is deferred with after() like the recording is. Captured here so
// running the deferred work never reaches the real alert store.
const sendThrottledAlert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert,
}));

import { POST } from "./route";

function post(body: string, auth: string | null = "Bearer inbound-secret") {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth !== null) headers.set("authorization", auth);
  return POST(new Request("http://localhost/api/regal/calls", { method: "POST", headers, body }) as never);
}

const BODY = JSON.stringify({ name: "call.completed", eventId: "e1", properties: {} });

async function drain() {
  const jobs = deferred.jobs.splice(0);
  for (const job of jobs) await job();
}

describe("POST /api/regal/calls", () => {
  beforeEach(() => {
    env.regalInboundKey.mockReturnValue("inbound-secret");
    recorded.bodies.length = 0;
    recorded.fail = false;
    recorded.duplicate = false;
    recorded.throwAll = false;
    recorded.outcome = { ok: true, value: { status: "stored", eventId: "e1" } };
    logInfo.mockReset();
    logWarn.mockReset();
    deferred.jobs.length = 0;
    logError.mockReset();
  });

  it("refuses by name with 503 when the secret is unset, and records nothing", async () => {
    env.regalInboundKey.mockReturnValue("");
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "regal call feed not configured: REGAL_INBOUND_KEY is unset" });
    expect(deferred.jobs).toHaveLength(0);
  });

  it("refuses a wrong, missing or malformed key with 401, and records nothing", async () => {
    expect((await post(BODY, "Bearer wrong")).status).toBe(401);
    expect((await post(BODY, null)).status).toBe(401);
    expect((await post(BODY, "inbound-secret")).status).toBe(401);
    // What a refusal defers is the limiter's page about the caller, never the recording.
    for (const job of deferred.jobs.splice(0)) await job();
    expect(recorded.bodies).toHaveLength(0);
  });

  it("answers before recording, then records the parsed body in after()", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(recorded.bodies).toHaveLength(0);
    expect(deferred.jobs).toHaveLength(1);
    await drain();
    expect(recorded.bodies).toEqual([JSON.parse(BODY)]);
  });

  it("refuses an unreadable body with 400 without throwing, and still counts it", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    await drain();
    expect(recorded.bodies).toEqual([null]);
  });

  it("refuses an oversized body as unreadable rather than parsing it", async () => {
    const huge = JSON.stringify({ name: "call.completed", pad: "x".repeat(300_000) });
    const res = await post(huge);
    expect(res.status).toBe(413);
    await drain();
    expect(recorded.bodies).toEqual([null]);
  });

  it("refuses a body that DECLARES itself oversized before reading any of it", async () => {
    // A request double, because the fact under test is that the body is never
    // buffered: `text` must not be called at all.
    const text = vi.fn(async () => "{}");
    const req = {
      headers: new Headers({ authorization: "Bearer inbound-secret", "content-length": String(10 * 1024 * 1024) }),
      text,
    };
    const res = await POST(req as never);
    expect(res.status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    await drain();
    expect(recorded.bodies).toEqual([null]);
  });

  it("still measures what arrived when the declared length is missing or lies", async () => {
    const huge = JSON.stringify({ name: "call.completed", pad: "x".repeat(300_000) });
    // A streamed body carries no length at all, so only what arrives can be measured.
    const bytes = new TextEncoder().encode(huge);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.slice(i, i + 4096));
        controller.close();
      },
    });
    const req = new Request("https://slate.test/api/regal/calls", {
      method: "POST",
      headers: { authorization: "Bearer inbound-secret" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await POST(req as never)).status).toBe(413);
    await drain();
    expect(recorded.bodies).toEqual([null]);
  });

  it("logs a redelivery as a duplicate, never as a fresh classification", async () => {
    recorded.duplicate = true;
    await post(BODY);
    await drain();
    expect(logInfo).toHaveBeenCalledWith("regal-calls", { msg: "duplicate", event_id: "e1" });
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("reason");
  });

  it("logs a failed recording loudly rather than swallowing it", async () => {
    recorded.fail = true;
    expect((await post(BODY)).status).toBe(200);
    await drain();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toBe("regal-calls");
    // The outcome half was still stored and still says so (#2944).
    expect(logInfo).toHaveBeenCalledWith("regal-call-outcomes", { msg: "stored", event_id: "e1" });
  });

  it("logs a failed OUTCOME insert on its own tag, with the detector row still recorded (#2944)", async () => {
    recorded.outcome = { ok: false, error: new Error("outcome insert refused") };
    await post(BODY);
    await drain();
    expect(logInfo).toHaveBeenCalledWith("regal-calls", { msg: "recorded", reason: "candidate" });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toBe("regal-call-outcomes");
    expect((logError.mock.calls[0][2] as Error).message).toBe("outcome insert refused");
  });

  it("logs a refused outcome by its reason, as a warning when it means the body changed (#2944)", async () => {
    recorded.outcome = { ok: true, value: { status: "refused", reason: "talk_time_unreadable", eventId: "e1" } };
    await post(BODY);
    await drain();
    expect(logWarn).toHaveBeenCalledWith("regal-call-outcomes", {
      msg: "refused",
      reason: "talk_time_unreadable",
      event_id: "e1",
    });
  });

  it("logs a non call event's refusal as ordinary rather than as a warning (#2944)", async () => {
    recorded.outcome = { ok: true, value: { status: "refused", reason: "not_call_completed", eventId: "e1" } };
    await post(BODY);
    await drain();
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith("regal-call-outcomes", {
      msg: "refused",
      reason: "not_call_completed",
      event_id: "e1",
    });
  });

  it("logs a duplicate outcome as a no op (#2944)", async () => {
    recorded.outcome = { ok: true, value: { status: "duplicate", eventId: "e1" } };
    await post(BODY);
    await drain();
    expect(logInfo).toHaveBeenCalledWith("regal-call-outcomes", { msg: "duplicate", event_id: "e1" });
  });

  it("still logs loudly if recording throws outright", async () => {
    recorded.throwAll = true;
    expect((await post(BODY)).status).toBe(200);
    await drain();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
