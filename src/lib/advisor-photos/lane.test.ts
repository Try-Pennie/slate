// The advisor photo lane's alerts and verdict (#3027), with the refresh itself
// replaced so each outcome is produced on demand. This is the all clear proof:
// a refused run, a failed save and a tripped guard must never send an all clear,
// and must never stamp the verdict.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RefreshPlan } from "@/lib/advisor-photos/core";

const h = vi.hoisted(() => ({
  outcome: null as unknown,
  throwOnRun: false,
  sent: [] as { key: string; text: string }[],
  resolved: [] as string[],
  verdicts: [] as { lane: string; reached: boolean }[],
  lastVerdictMs: null as number | null,
  runs: 0,
  lock: "claim" as string | null,
}));

vi.mock("@/lib/locks", () => ({
  acquireLock: async () => h.lock,
  releaseLock: async () => {},
}));
vi.mock("@/lib/log", () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));
vi.mock("@/lib/env", () => ({ directoryAdminSubject: () => "admin@x.test" }));
vi.mock("@/lib/monitor/heartbeat", () => ({ readHeartbeatMsStrict: async () => h.lastVerdictMs }));
vi.mock("@/lib/monitor/verdict-store", () => ({
  recordDetectorVerdict: async (lane: string, reached: boolean) => void h.verdicts.push({ lane, reached }),
}));
vi.mock("@/lib/monitor/settings", () => ({
  loadMonitorCooldowns: async () => ({ advisor_photos_unread: 1000, advisor_photos_held: 1000 }),
}));
const resolveAlert = vi.hoisted(() =>
  vi.fn(async (key: string, _text: string) => {
    h.resolved.push(key);
    return true;
  }),
);
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: async (key: string, _ms: number, text: string) => void h.sent.push({ key, text }),
  resolveAlert,
}));
vi.mock("@/lib/advisor-photos/google", () => ({ listDirectoryAccounts: async () => [], getDirectoryPhoto: async () => ({ status: 404, body: "" }) }));
vi.mock("@/lib/advisor-photos/store", () => ({
  listPhotoSubjects: async () => [],
  listStoredPhotoStates: async () => [],
  photoWrites: () => ({}),
}));
vi.mock("@/lib/advisor-photos/refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/advisor-photos/refresh")>()),
  runPhotoRefresh: async () => {
    h.runs += 1;
    if (h.throwOnRun) throw new Error("read failed [advisor photo write]: timeout");
    return h.outcome;
  },
}));

import { runAdvisorPhotoLane, startOfUtcDay } from "@/lib/advisor-photos/lane";

const plan = (over: Partial<RefreshPlan> = {}): RefreshPlan => ({
  full: [],
  touch: [],
  failed: [],
  failedNeverRead: [],
  deleteIds: [],
  flipGuardTripped: false,
  heldNone: [],
  repeated: [],
  notInDirectory: [],
  streaks: [],
  counts: { attempted: 2, photo: 1, none: 1, placeholder: 0, notInDirectory: 0, failed: 0, gained: 0, lost: 0, changed: 0, unchanged: 2, deleted: 0 },
  ...over,
});

beforeEach(() => {
  resolveAlert.mockClear();
  h.outcome = null;
  h.throwOnRun = false;
  h.sent = [];
  h.resolved = [];
  h.verdicts = [];
  h.lastVerdictMs = null;
  h.runs = 0;
  h.lock = "claim";
});

describe("the advisor photo lane", () => {
  it("clears both alerts and stamps the verdict on a measured, healthy run", async () => {
    h.outcome = { status: "measured", plan: plan(), applied: true, verdict: true };
    await runAdvisorPhotoLane("cron");
    expect(h.resolved.sort()).toEqual(["advisor_photos_held", "advisor_photos_unread"]);
    expect(h.sent).toEqual([]);
    expect(h.verdicts).toEqual([{ lane: "verdict:advisor-photos", reached: true }]);
  });

  it("sends no all clear and no verdict when the run was refused", async () => {
    h.outcome = { status: "refused", why: "subject-refused", detail: "403" };
    await runAdvisorPhotoLane("cron");
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([]);
    expect(h.sent.map((s) => s.key)).toEqual(["advisor_photos_unread"]);
    expect(h.sent[0]!.text).toMatch(/admin role|delegation/);
  });

  it("sends no all clear and no verdict when saving failed", async () => {
    h.throwOnRun = true;
    const result = await runAdvisorPhotoLane("cron");
    expect(result.status).toBe("failed");
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([]);
    expect(h.sent.map((s) => s.key)).toEqual(["advisor_photos_unread"]);
  });

  it("pages and withholds both the held all clear and the verdict when the flip guard trips", async () => {
    h.outcome = { status: "measured", plan: plan({ flipGuardTripped: true, heldNone: ["a@x", "b@x", "c@x", "d@x"] }), applied: true, verdict: false };
    await runAdvisorPhotoLane("cron");
    expect(h.sent.map((s) => s.key)).toEqual(["advisor_photos_held"]);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([{ lane: "verdict:advisor-photos", reached: false }]);
  });

  it("pages a repeated image but still reaches a verdict", async () => {
    h.outcome = {
      status: "measured",
      plan: plan({ repeated: [{ sha256: "a".repeat(64), holders: ["a", "b", "c"], held: ["c"] }] }),
      applied: true,
      verdict: true,
    };
    await runAdvisorPhotoLane("cron");
    expect(h.sent.map((s) => s.key)).toEqual(["advisor_photos_held"]);
    expect(h.resolved).toEqual(["advisor_photos_unread"]);
  });

  it("the scheduled retry stands down once today has a verdict, and the manual trigger never does", async () => {
    h.outcome = { status: "measured", plan: plan(), applied: true, verdict: true };
    h.lastVerdictMs = startOfUtcDay(Date.now()) + 1;
    expect((await runAdvisorPhotoLane("cron")).status).toBe("skipped");
    expect(h.runs).toBe(0);
    await runAdvisorPhotoLane("manual");
    expect(h.runs).toBe(1);
    h.lastVerdictMs = startOfUtcDay(Date.now()) - 1;
    await runAdvisorPhotoLane("cron");
    expect(h.runs).toBe(2);
  });

  it("skips an overlapping run without reading anything", async () => {
    h.lock = null;
    expect(await runAdvisorPhotoLane("manual")).toEqual({ status: "skipped", why: "overlapping-run" });
    expect(h.runs).toBe(0);
  });
});
