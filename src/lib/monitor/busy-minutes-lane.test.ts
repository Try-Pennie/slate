// The busy minute lane's IO (#3124), with each read replaced so every outcome is
// produced on demand. This is the all clear proof: a Slate read that errors, a cal.com
// read that is refused, throws or finds no key, and an unreadable retired switch must
// never send an all clear and never stamp the verdict; the could not count page goes
// out only on the day's last attempt.
import { describe, it, expect, vi, beforeEach } from "vitest";

const MIN = 60_000;
const minuteOf = (iso: string): number => Math.floor(Date.parse(iso) / MIN);

const h = vi.hoisted(() => ({
  rpc: { data: null as unknown, error: null as { message: string } | null },
  rpcThrows: false,
  rpcArgs: [] as unknown[],
  retired: false as boolean | null,
  calcom: null as unknown,
  calcomThrows: false,
  calcomFrom: [] as string[],
  sent: [] as { key: string; text: string; subjects?: readonly string[] }[],
  verdicts: [] as { lane: string; reached: boolean }[],
  lastVerdictMs: null as number | null,
  lock: "claim" as string | null,
  loadtest: false,
}));

vi.mock("@/lib/locks", () => ({ acquireLock: async () => h.lock, releaseLock: async () => {} }));
vi.mock("@/lib/log", () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));
vi.mock("@/lib/loadtest-guard", () => ({ isLoadtest: () => h.loadtest }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async (name: string, args: unknown) => {
      h.rpcArgs.push({ name, args });
      if (h.rpcThrows) throw new Error("fetch failed");
      return h.rpc;
    },
  }),
}));
vi.mock("@/lib/calcom/retirement", () => ({ loadCalcomRetired: async () => h.retired }));
vi.mock("@/lib/calcom/client", () => ({
  readCalcomRoutingResponses: async (fromIso: string) => {
    h.calcomFrom.push(fromIso);
    if (h.calcomThrows) throw new Error("socket hang up");
    return h.calcom;
  },
}));
vi.mock("@/lib/monitor/heartbeat", () => ({ readHeartbeatMsStrict: async () => h.lastVerdictMs }));
vi.mock("@/lib/monitor/verdict-store", () => ({
  recordDetectorVerdict: async (lane: string, reached: boolean) => void h.verdicts.push({ lane, reached }),
}));
vi.mock("@/lib/monitor/settings", () => ({
  loadMonitorCooldowns: async () => ({ load_bar_outgrown: 1000, load_bar_unread: 1000 }),
}));
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: async (key: string, _ms: number, text: string, opts?: { subjects?: readonly string[] }) => {
    h.sent.push({ key, text, subjects: opts?.subjects });
  },
  resolveAlert,
}));

import { runBusyMinutesLane } from "@/lib/monitor/busy-minutes-lane";

const FIRST = Date.parse("2026-10-20T05:41:00Z");
const RETRY = Date.parse("2026-10-20T09:41:00Z");

const slateRows = (...pairs: [string, number][]) => pairs.map(([iso, n]) => [minuteOf(iso), n]);
const calRows = (...stamps: string[]) => ({
  ok: true,
  formCount: 1,
  rows: stamps.map((createdAt, i) => ({ id: String(i), formName: "A", createdAt, code: "111", booked: true })),
});
const busy = () =>
  slateRows(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 8], ["2026-10-17T13:23:00Z", 8]);

beforeEach(() => {
  resolveAlert.mockClear();
  h.rpc = { data: slateRows(["2026-10-14T14:20:00Z", 2]), error: null };
  h.rpcThrows = false;
  h.rpcArgs = [];
  h.retired = false;
  h.calcom = calRows("2026-10-15T14:00:00Z");
  h.calcomThrows = false;
  h.calcomFrom = [];
  h.sent = [];
  h.verdicts = [];
  h.lastVerdictMs = null;
  h.lock = "claim";
  h.loadtest = false;
});

describe("the busy minute lane", () => {
  it("asks both systems for the same 7 whole UTC days", async () => {
    await runBusyMinutesLane(FIRST);
    expect(h.rpcArgs).toEqual([
      { name: "routed_bookings_per_minute", args: { p_from: "2026-10-13T00:00:00.000Z", p_to: "2026-10-20T00:00:00.000Z" } },
    ]);
    expect(h.calcomFrom).toEqual(["2026-10-13T00:00:00.000Z"]);
  });

  it("on a measured quiet week, clears both alerts and stamps the verdict", async () => {
    const r = await runBusyMinutesLane(FIRST);
    expect(r.status).toBe("measured");
    expect(resolveAlert.mock.calls.map((c) => c[0]).sort()).toEqual(["load_bar_outgrown", "load_bar_unread"]);
    expect(h.sent).toEqual([]);
    expect(h.verdicts).toEqual([{ lane: "verdict:busy-minutes", reached: true }]);
  });

  it("on a measured crossing, sends the outgrown alert and clears only the could not count page", async () => {
    h.rpc = { data: busy(), error: null };
    await runBusyMinutesLane(FIRST);
    expect(h.sent.map((s) => s.key)).toEqual(["load_bar_outgrown"]);
    expect(h.sent[0]!.text).toContain("3 of the last 7 days");
    expect(resolveAlert.mock.calls.map((c) => c[0])).toEqual(["load_bar_unread"]);
    expect(h.verdicts).toEqual([{ lane: "verdict:busy-minutes", reached: true }]);
  });

  it("adds cal.com's routed responses to Slate's minute", async () => {
    h.rpc = { data: slateRows(["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 4], ["2026-10-17T13:23:00Z", 4]), error: null };
    h.calcom = calRows(
      ...Array.from({ length: 4 }, () => "2026-10-14T14:20:10Z"),
      ...Array.from({ length: 4 }, () => "2026-10-15T15:30:10Z"),
      ...Array.from({ length: 4 }, () => "2026-10-17T13:23:10Z"),
    );
    const r = await runBusyMinutesLane(FIRST);
    expect(r).toMatchObject({ status: "measured", raise: true, crossingDays: 3, busiest: 8 });
  });

  it("leaves cal.com responses that went to no booking out of the count", async () => {
    h.calcom = { ...calRows("2026-10-15T14:00:00Z"), rows: [{ id: "9", formName: "A", createdAt: "2026-10-15T14:00:00Z", code: "111", booked: false }] };
    const r = await runBusyMinutesLane(FIRST);
    expect(r).toMatchObject({ status: "unmeasured", reasons: ["calcom-empty"] });
  });

  it("a Slate read that errors is never a quiet week: no all clear, no verdict, and no page before the last attempt", async () => {
    h.rpc = { data: null, error: { message: "permission denied for function routed_bookings_per_minute" } };
    const r = await runBusyMinutesLane(FIRST);
    expect(r).toMatchObject({ status: "unmeasured", reasons: ["slate-unreadable"], finalAttempt: false });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.verdicts).toEqual([]);
  });

  it("on the day's last attempt, a failed read pages that it could not count, and clears nothing", async () => {
    h.rpcThrows = true;
    h.calcom = { ok: false, reason: "responses-unreadable", status: 429, formName: "Debt relief" };
    const r = await runBusyMinutesLane(RETRY);
    expect(r).toMatchObject({ status: "unmeasured", reasons: ["slate-unreadable", "calcom-unreadable"], finalAttempt: true });
    expect(h.sent.map((s) => s.key)).toEqual(["load_bar_unread"]);
    expect(h.sent[0]!.subjects).toEqual(["slate-unreadable", "calcom-unreadable"]);
    expect(h.sent[0]!.text).toContain("429");
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([]);
  });

  it("a cal.com read that throws, no cal.com key, or an unreadable retired switch each cannot count", async () => {
    h.rpc = { data: busy(), error: null };
    h.calcomThrows = true;
    expect(await runBusyMinutesLane(RETRY)).toMatchObject({ status: "unmeasured", reasons: ["calcom-unreadable"] });
    h.calcomThrows = false;
    h.calcom = null;
    expect(await runBusyMinutesLane(RETRY)).toMatchObject({ status: "unmeasured", reasons: ["calcom-not-configured"] });
    h.retired = null;
    expect(await runBusyMinutesLane(RETRY)).toMatchObject({ status: "unmeasured", reasons: ["calcom-retired-unknown"] });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(h.sent.every((s) => s.key === "load_bar_unread")).toBe(true);
    expect(h.verdicts).toEqual([]);
  });

  it("after cutover counts Slate alone and never asks cal.com", async () => {
    h.retired = true;
    h.rpc = { data: busy(), error: null };
    const r = await runBusyMinutesLane(FIRST);
    expect(r).toMatchObject({ status: "measured", raise: true, calcomCounted: false });
    expect(h.calcomFrom).toEqual([]);
    expect(h.sent[0]!.text).toMatch(/Slate alone/);
  });

  it("the retry stands down once today has a verdict, and a held lock or a load test runs nothing", async () => {
    h.lastVerdictMs = Date.parse("2026-10-20T05:42:00Z");
    expect(await runBusyMinutesLane(RETRY)).toEqual({ status: "skipped", why: "already-measured-today" });
    h.lastVerdictMs = Date.parse("2026-10-19T05:42:00Z");
    h.lock = null;
    expect(await runBusyMinutesLane(RETRY)).toEqual({ status: "skipped", why: "overlapping-run" });
    h.loadtest = true;
    expect(await runBusyMinutesLane(RETRY)).toEqual({ status: "skipped", why: "loadtest" });
    expect(h.rpcArgs).toEqual([]);
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});
