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
