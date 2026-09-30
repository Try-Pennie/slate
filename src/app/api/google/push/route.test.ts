import { describe, it, expect, vi, beforeEach } from "vitest";

// Reliability wiring for the Google push handler (#191): the route acks Google's
// delivery immediately, then finishes the per-calendar incremental sync in the
// background. On the Cloudflare Workers runtime a bare fire-and-forget promise is
// cut off once the response is sent, so the sync could silently never complete.
// These tests pin that the background sync is scheduled through next/server's
// after() (which keeps the Worker alive until it settles) rather than a floating
// promise, and that the ack timing is unchanged.

const env = vi.hoisted(() => ({
  googleChannelToken: vi.fn(() => "secret-token"),
}));
const sync = vi.hoisted(() => ({
  syncByChannel: vi.fn(async () => {}),
}));
const server = vi.hoisted(() => ({
  // Mirror the runtime: after() runs the callback (the Cloudflare waitUntil the
  // real after() maps to). We assert it was handed the work; running it lets us
  // confirm the callback drives the sync.
  after: vi.fn((cb: () => void) => {
    cb();
  }),
}));

const logError = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: logInfo } }));

// #1046: the channel token is the ONLY credential on this endpoint, and it was
// the last machine-endpoint secret in the tree still compared with a plain `!==`
// after #594 consolidated every other one onto the shared constant-time verifier.
// The spy wraps the REAL implementation, so the behaviour under test is the real
// comparison and only the delegation is observed.
const timingSafeEqualSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bearer-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bearer-auth")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/google/sync", () => sync);
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: server.after };
});

import { POST } from "./route";
import { NextRequest } from "next/server";

function push(headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/google/push", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Google push handler", () => {
  it("schedules the background sync via after(), not a floating promise", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    // Ack is immediate and unchanged.
    expect(res.status).toBe(200);

    // The sync must be handed to after() so the Cloudflare runtime keeps the
    // Worker alive until it settles. A bare syncByChannel(...).catch() would run
    // outside after() and get torn down after the response.
    expect(server.after).toHaveBeenCalledTimes(1);
    expect(server.after).toHaveBeenCalledWith(expect.any(Function));

    // And the scheduled callback actually drives the sync for the pinged channel.
    expect(sync.syncByChannel).toHaveBeenCalledTimes(1);
    expect(sync.syncByChannel).toHaveBeenCalledWith("chan-1");
  });

  it("does not schedule a sync when the channel confirmation ping arrives", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "sync",
        "x-goog-channel-id": "chan-1",
      }),
    );

    expect(res.status).toBe(200);
    expect(server.after).not.toHaveBeenCalled();
    expect(sync.syncByChannel).not.toHaveBeenCalled();
  });

  it("rejects a bad channel token before scheduling any work", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "wrong",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    expect(res.status).toBe(403);
    expect(server.after).not.toHaveBeenCalled();
    expect(sync.syncByChannel).not.toHaveBeenCalled();
  });
});

// #1049: Google does NOT redeliver a push notification, so a background sync that
// fails is a calendar change that waits for the 1-minute backstop. That is
// survivable; being unable to tell it ever happened is not. The rejection used to
// be discarded by a bare catch.
describe("Google push handler background failures are recorded", () => {
  it("logs when the background sync rejects, and still acks 200", async () => {
    sync.syncByChannel.mockRejectedValueOnce(new Error("sync token expired"));

    const res = await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    // Google must still get its immediate ack; it retries aggressively on non-2xx.
    expect(res.status).toBe(200);
    // Let the after() callback's rejection settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, fields, err] = logError.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(tag).toBe("google-push");
    // The channel id is what ties the line back to a calendar.
    expect(fields.channel_id).toBe("chan-1");
    expect(err).toBeInstanceOf(Error);
  });

  // #2922: Cloudflare cancelled 88% of push syncs at its post response limit and
  // nothing in Slate could see it. A cancelled job cannot report itself, so the
  // count lives on the side that FINISHED: one line per completed push, which a
  // query sets against Cloudflare's own cancellation warnings.
  it("records each push whose work finished, with its outcome and elapsed time", async () => {
    sync.syncByChannel.mockResolvedValueOnce("synced" as never);
    await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const finished = logInfo.mock.calls.filter(
      ([tag, fields]) => tag === "google-push" && (fields as { msg?: string }).msg === "push work finished",
    );
    expect(finished).toHaveLength(1);
    const fields = finished[0][1] as Record<string, unknown>;
    expect(fields.channel_id).toBe("chan-1");
    expect(fields.outcome).toBe("synced");
    expect(typeof fields.ms).toBe("number");
  });

  it("does not record a failed push as finished", async () => {
    sync.syncByChannel.mockRejectedValueOnce(new Error("boom"));
    await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(logInfo).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("logs nothing when the background sync succeeds", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );
    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(logError).not.toHaveBeenCalled();
  });
});

// #1046: every other machine endpoint compares its secret through the one
// constant-time verifier (`src/lib/bearer-auth.ts`, #594). This one compared with
// `!==`, which leaks how many leading characters of the channel token a guess got
// right. The pair of tests below is deliberate: the delegation test pins the
// MECHANISM (a plain `===` would satisfy every behavioural assertion in this
// file), and the missing-header test pins the case the mechanism change can
// break, because `timingSafeEqual` takes two strings and the header is nullable.
describe("Google push channel token is compared in constant time", () => {
  it("compares through the shared constant-time verifier", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    expect(res.status).toBe(200);
    expect(timingSafeEqualSpy).toHaveBeenCalledWith("secret-token", "secret-token");
  });

  it("still 403s a wrong token through the verifier", async () => {
    const res = await POST(
      push({
        "x-goog-channel-token": "wrong",
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    expect(res.status).toBe(403);
    expect(timingSafeEqualSpy).toHaveBeenCalledWith("wrong", "secret-token");
  });

  it("403s a request with no channel token at all, without comparing a null", async () => {
    const res = await POST(
      push({
        "x-goog-resource-state": "exists",
        "x-goog-channel-id": "chan-1",
      }),
    );

    expect(res.status).toBe(403);
    // A missing header must be refused BEFORE the comparison: passing null into a
    // string comparison would throw a 500, which reads to Google as retriable.
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
    expect(server.after).not.toHaveBeenCalled();
    expect(sync.syncByChannel).not.toHaveBeenCalled();
  });
});
