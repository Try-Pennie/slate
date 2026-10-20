import { describe, it, expect, vi, beforeEach } from "vitest";

// #3936: setNearlyFullPct, the line at which Team capacity flags a day nearly full. Pinned: admin
// only; a whole number from 1 to 99, a refusal naming what to enter; a column scoped upsert on
// id=1; an audit entry with the line it replaced and the line it became; a refused write never
// audits, invalidates or confirms. Only DB/auth/audit/next and the settings read are mocked.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const upsert = vi.hoisted(() => vi.fn(async (_row: Record<string, unknown>, _opts: { onConflict: string }) => ({ error: null as { message: string } | null })));
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const readNearlyFullPct = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 85));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/booking/settings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/booking/settings")>()), readNearlyFullPct }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setNearlyFullPct } from "./actions";

const form = (pct: string) => { const fd = new FormData(); fd.set("capacity_nearly_full_pct", pct); return fd; };
const landing = (run: Promise<unknown>) => run.then(() => "", (e: unknown) => String(e));

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  readNearlyFullPct.mockResolvedValue(85);
  upsert.mockResolvedValue({ error: null });
});

describe("setNearlyFullPct (#3936)", () => {
  it("rejects a non-admin and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setNearlyFullPct(form("90"))).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("saves the line on the one settings row, audits from and to, and says it saved", async () => {
    expect(await landing(setNearlyFullPct(form(" 90 ")))).toMatch(/NEXT_REDIRECT:\/admin\/team-capacity\?ok=nearly-full/);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 1, capacity_nearly_full_pct: 90, updated_by: "admin1" }), { onConflict: "id" });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.settings",
      details: { from: { capacity_nearly_full_pct: 85 }, to: { capacity_nearly_full_pct: 90 } },
    }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin/team-capacity");
  });

  it("still saves when the old line cannot be read, and says so in the trail", async () => {
    readNearlyFullPct.mockResolvedValueOnce(null);
    await landing(setNearlyFullPct(form("70")));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { from: { capacity_nearly_full_pct: "unreadable" }, to: { capacity_nearly_full_pct: 70 } } }));
  });

  it.each(["0", "100", "85.5", "", "eighty"])("refuses %j, naming what to enter, and writes nothing", async (raw) => {
    expect(decodeURIComponent(await landing(setNearlyFullPct(form(raw))))).toContain("Enter a whole number from 1 to 99.");
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a write the database refused, before any audit or confirmation", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    const where = await landing(setNearlyFullPct(form("90")));
    expect(where).toMatch(/\?error=/);
    expect(where).not.toMatch(/ok=/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
