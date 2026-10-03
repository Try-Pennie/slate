import { describe, it, expect, vi, beforeEach } from "vitest";

// #3133 follow-up: "I only want one alert" (Dan, 2026-10-03). The dispatcher can
// only stay quiet about a lane failure the lane already paged about if the code
// that pages RECORDS that it did. These pin where the record is written, and
// where it is deliberately not: a send or a streak that failed spoke for nobody.

const rpc = vi.hoisted(() => ({
  reply: { data: true as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async () => rpc.reply,
    from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));
vi.mock("@/lib/platform/runtime", () => ({
  isWorkersRuntime: () => false,
  workersRuntimeMarker: () => "test",
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { noteAlertKey, recordingAlerts } from "./alert-recording";
import { sendThrottledAlert } from "./dispatch";
import { recordConsecutiveStreak } from "./streak";

beforeEach(() => {
  rpc.reply = { data: true, error: null };
});

describe("recordingAlerts", () => {
  it("records what was noted inside its scope, once each, in order", async () => {
    const r = await recordingAlerts(async () => {
      noteAlertKey("a");
      noteAlertKey("b");
      noteAlertKey("a");
      return 7;
    });
    expect(r).toEqual({ ok: true, value: 7, keys: ["a", "b"] });
  });

  it("ignores a note made outside any scope", async () => {
    noteAlertKey("stray");
    const r = await recordingAlerts(async () => undefined);
    expect(r.keys).toEqual([]);
  });

  it("returns a throw with only the keys noted BEFORE it", async () => {
    const boom = new Error("boom");
    const r = await recordingAlerts(async () => {
      noteAlertKey("before");
      throw boom;
    });
    expect(r).toEqual({ ok: false, error: boom, keys: ["before"] });
  });

  it("keeps two concurrent scopes apart", async () => {
    // x notes only after y has run, released by y itself rather than by a timer.
    let release!: () => void;
    const yDone = new Promise<void>((r) => (release = r));
    const [x, y] = await Promise.all([
      recordingAlerts(async () => {
        await yDone;
        noteAlertKey("x");
      }),
      recordingAlerts(async () => {
        noteAlertKey("y");
        release();
      }),
    ]);
    expect(x.keys).toEqual(["x"]);
    expect(y.keys).toEqual(["y"]);
  });
});

describe("the senders note their key", () => {
  it("sendThrottledAlert notes a key it returned for", async () => {
    // Off the Workers runtime the send returns without posting: the owner's
    // decision was still made, so the generic page must not repeat it.
    const r = await recordingAlerts(() => sendThrottledAlert("agent_sync_failures", 60_000, "t"));
    expect(r.keys).toEqual(["agent_sync_failures"]);
  });

  it("sendThrottledAlert does NOT note a send that threw", async () => {
    const r = await recordingAlerts(() => sendThrottledAlert("agent_sync_failures", Number.NaN, "t"));
    expect(r.ok).toBe(false);
    expect(r.keys).toEqual([]);
  });

  it("recordConsecutiveStreak notes a streak it tracked that is deliberately quiet", async () => {
    rpc.reply = { data: true, error: null }; // still under the limit: no page yet
    const r = await recordingAlerts(() => recordConsecutiveStreak("agents_sync_streak", 60, 2));
    expect(r).toMatchObject({ ok: true, value: false });
    expect(r.keys).toEqual(["agents_sync_streak"]);
  });

  it("does NOT note a streak that reached its threshold, so only the send can speak", async () => {
    rpc.reply = { data: false, error: null }; // over the limit: the caller sends
    const r = await recordingAlerts(() => recordConsecutiveStreak("agents_sync_streak", 60, 2));
    expect(r).toMatchObject({ ok: true, value: true });
    expect(r.keys).toEqual([]);
  });

  it("recordConsecutiveStreak does NOT note a streak it could not track", async () => {
    rpc.reply = { data: null, error: { message: "rpc down" } };
    const r = await recordingAlerts(() => recordConsecutiveStreak("agents_sync_streak", 60, 2));
    expect(r.keys).toEqual([]);
  });
});
