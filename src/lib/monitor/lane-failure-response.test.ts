import { describe, it, expect, vi } from "vitest";

// #3133 follow-up: one failure, one message (Dan, 2026-10-03). Each way a lane's
// own failure alerting can go, and whether the response tells the dispatcher it
// already spoke. The noting itself is pinned in src/lib/notify/alert-recording.test.ts;
// the dispatcher's reading of the header in scripts/test-cron-lane-run.ts.
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { laneFailure, laneFailedResponse } from "./lane-failure-response";
import { noteAlertKey } from "@/lib/notify/alert-recording";

const HEADER = "x-slate-lane-alerted";

describe("laneFailure", () => {
  it("answers 500 with no header when the lane has no alerting of its own", async () => {
    const res = await laneFailure("t", "boom");
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBeNull();
    expect(await res.json()).toEqual({ error: "boom" });
  });

  it("answers with no header when its own alerting raised nothing", async () => {
    const res = await laneFailure("t", "boom", async () => {});
    expect(res.headers.get(HEADER)).toBeNull();
  });

  it("names the keys its own alerting raised, so the generic page is not sent", async () => {
    const res = await laneFailure("t", "boom", async () => {
      noteAlertKey("agent_sync_failures");
    });
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBe("agent_sync_failures");
  });

  // The case the issue asked to decide: the lane's own alerting throws before it
  // raised anything. Nobody has spoken, so no header, and the generic page is the
  // one message about this failure.
  it("sets no header when its own alerting threw before raising anything", async () => {
    const res = await laneFailure("t", "boom", async () => {
      throw new Error("streak rpc threw");
    });
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBeNull();
  });

  it("keeps the header when its own alerting threw AFTER raising its alert", async () => {
    const res = await laneFailure("t", "boom", async () => {
      noteAlertKey("agent_sync_failures");
      throw new Error("later cleanup threw");
    });
    expect(res.headers.get(HEADER)).toBe("agent_sync_failures");
  });
});

describe("laneFailedResponse", () => {
  it("sets the header only for a non-empty key list", () => {
    expect(laneFailedResponse({}, []).headers.get(HEADER)).toBeNull();
    expect(laneFailedResponse({}, ["a", "b"]).headers.get(HEADER)).toBe("a,b");
    expect(laneFailedResponse({}, ["a"]).status).toBe(500);
  });
});
