import { describe, it, expect, vi, beforeEach } from "vitest";

// #4390: the live wiring of a program lead's times. The rules (the shared start predicate,
// the day limit, every fallback) are pinned by scripts/test-program-lead-times.ts; this
// proves the reads and the count reach the real store the way the rules assume: the day
// counts through placeholder_day_counts, the fallback through bump_program_lead_outcome,
// and a fallback is logged with its reason, never the token.

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));
const settings = vi.hoisted(() => ({
  readProgramLeadTimesSettings: vi.fn(async () => ({ enabled: true, dayLimit: 50 }) as { enabled: boolean; dayLimit: number } | null),
  readBookingHorizonDays: vi.fn(async () => 2 as number | null),
}));
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/booking/business-hours-load", () => ({
  loadBusinessHoursCached: vi.fn(async () => ({
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1080 })),
    exceptions: [],
  })),
}));
const gate = vi.hoisted(() => ({
  readProgramLeadTimesToken: vi.fn(
    (): { ok: true; facts: { purpose: "new" | "move"; bookingId: string | null } } | { ok: false; reason: string } => ({
      ok: true,
      facts: { purpose: "new", bookingId: null },
    }),
  ),
}));
vi.mock("@/lib/booking/program-lead-gate", () => gate);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { programLeadTimesLive } from "./program-lead-times-live";
import { log } from "@/lib/log";

const MONDAY_MORNING = Date.parse("2026-06-08T12:00:00.000Z");
const TOKEN = "00Q5f00000AbCdE.new.1.abc";
const ASK = {
  token: TOKEN,
  leadZone: "America/New_York",
  realSlots: ["2026-06-08T15:00:00.000Z"],
  eventType: { duration_min: 20, slot_interval_min: 30, min_notice_min: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_MORNING);
  rpc.mockImplementation(async (fn: string, args: Record<string, string>) => {
    if (fn === "placeholder_day_counts") {
      return {
        data: [
          { call_day: args.p_from, held: 50 },
          { call_day: args.p_to, held: 0 },
        ],
        error: null,
      };
    }
    return { data: 1, error: null };
  });
});

describe("programLeadTimesLive (#4390)", () => {
  it("reads the day counts once over the Eastern days the starts fall on, and drops the full day", async () => {
    const out = await programLeadTimesLive(ASK);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("placeholder_day_counts", { p_from: "2026-06-08", p_to: "2026-06-09" });
    expect(out.outcome).toBe("program");
    expect(out.placeholderStarts.length).toBeGreaterThan(0);
    expect(out.placeholderStarts.every((iso) => iso.startsWith("2026-06-09"))).toBe(true);
    expect(out.slots).toContain(ASK.realSlots[0]);
  });

  it("reads a move's days through placeholder_day_held, leaving the moving booking out (#4414)", async () => {
    gate.readProgramLeadTimesToken.mockReturnValueOnce({ ok: true, facts: { purpose: "move", bookingId: "bk-moving" } });
    rpc.mockImplementation(async (fn: string, args: Record<string, string>) =>
      fn === "placeholder_day_held" ? { data: args.p_day === "2026-06-08" ? 0 : 50, error: null } : { data: 1, error: null },
    );
    const out = await programLeadTimesLive(ASK);
    expect(rpc).not.toHaveBeenCalledWith("placeholder_day_counts", expect.anything());
    expect(rpc).toHaveBeenCalledWith("placeholder_day_held", { p_day: "2026-06-08", p_exclude_booking: "bk-moving" });
    expect(rpc).toHaveBeenCalledWith("placeholder_day_held", { p_day: "2026-06-09", p_exclude_booking: "bk-moving" });
    expect(out.outcome).toBe("program");
    expect(out.placeholderStarts.every((iso) => iso.startsWith("2026-06-08"))).toBe(true);
  });

  it("serves a move real slots only, counted, when a per day read fails (#4414)", async () => {
    gate.readProgramLeadTimesToken.mockReturnValueOnce({ ok: true, facts: { purpose: "move", bookingId: "bk-moving" } });
    rpc.mockImplementation(async (fn: string) =>
      fn === "placeholder_day_held" ? { data: null, error: { message: "boom" } } : { data: 1, error: null },
    );
    const out = await programLeadTimesLive(ASK);
    expect(out.outcome).toBe("fallback:counts-unreadable");
    expect(out.placeholderStarts).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("bump_program_lead_outcome", { p_kind: "times_fallback" });
  });

  it("counts a failed counts read as times_fallback and serves real slots only", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "placeholder_day_counts" ? { data: null, error: { message: "boom" } } : { data: 1, error: null },
    );
    const out = await programLeadTimesLive(ASK);
    expect(out).toMatchObject({ slots: ASK.realSlots, placeholderStarts: [], outcome: "fallback:counts-unreadable" });
    expect(rpc).toHaveBeenCalledWith("bump_program_lead_outcome", { p_kind: "times_fallback" });
    const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
    expect(logged).toContain("counts-unreadable");
    expect(logged).not.toContain(TOKEN);
  });

  it("counts a missing token secret, and says so when the count itself fails", async () => {
    gate.readProgramLeadTimesToken.mockReturnValueOnce({ ok: false, reason: "secret-unset" });
    rpc.mockResolvedValue({ data: null, error: { message: "bump failed" } });
    const out = await programLeadTimesLive(ASK);
    expect(out).toMatchObject({ slots: ASK.realSlots, outcome: "fallback:token-secret-unset" });
    expect(rpc).toHaveBeenCalledWith("bump_program_lead_outcome", { p_kind: "times_fallback" });
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).toContain("could not be counted");
  });

  it("counts nothing and reads nothing more for the switch off", async () => {
    settings.readProgramLeadTimesSettings.mockResolvedValueOnce({ enabled: false, dayLimit: 50 });
    const out = await programLeadTimesLive(ASK);
    expect(out).toMatchObject({ slots: ASK.realSlots, outcome: "switch-off" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
