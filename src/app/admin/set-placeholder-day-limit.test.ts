import { describe, it, expect, vi, beforeEach } from "vitest";
import { atLeast } from "@/lib/auth/roles";
import { NotAuthorizedError } from "@/lib/auth/http";
import type { Role } from "@/lib/db/types";

// #4392: setPlaceholderDayLimit, the placeholder day limit on /admin/program-leads. Pinned:
// ADMINS ONLY (Dan, 2026-10-29: anything added in the UI for this is visible to admins only),
// checked by the action itself through requireAdmin, which is requireRole("admin"); a whole
// number from 0 to 500, the column's own check, refused on the server with what to enter; a
// column scoped upsert on id=1; an audit entry with the limit it replaced and the one it became;
// a refused write never audits, invalidates or confirms; the outcome named on the page it is on.
//
// The role check is driven through the REAL rank predicate (`atLeast`, the one requireRole
// asks), so a role below admin is refused by the same rule production applies, not by a stub
// that was told to refuse it. requireRole's own wiring is pinned by src/lib/auth.test.ts.
const who = vi.hoisted(() => ({ role: "admin" as string | null }));
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const upsert = vi.hoisted(() =>
  vi.fn(async (_row: Record<string, unknown>, _opts: { onConflict: string }) => ({ error: null as { message: string } | null })),
);
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const readProgramLeadTimesSettings = vi.hoisted(() =>
  vi.fn(async (): Promise<{ enabled: boolean; dayLimit: number } | null> => ({ enabled: true, dayLimit: 50 })),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/booking/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/settings")>()),
  readProgramLeadTimesSettings,
}));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setPlaceholderDayLimit } from "./actions";

const form = (limit: string) => { const fd = new FormData(); fd.set("placeholder_day_limit", limit); return fd; };
const landing = (run: Promise<unknown>) => run.then(() => "", (e: unknown) => String(e));

beforeEach(() => {
  vi.clearAllMocks();
  who.role = "admin";
  // requireRole("admin") as it decides: the signed in person's rank against admin's. A
  // coordinator is nobody to the console (`currentUser` answers null), so it is refused too.
  auth.requireAdmin.mockImplementation(async () => {
    if (who.role === null || !atLeast(who.role as Role, "admin")) throw new NotAuthorizedError();
    return { id: "admin1", role: who.role, org_id: "o1" };
  });
  readProgramLeadTimesSettings.mockResolvedValue({ enabled: true, dayLimit: 50 });
  upsert.mockResolvedValue({ error: null });
});

describe("setPlaceholderDayLimit (#4392)", () => {
  it.each([
    ["team_lead", "team_lead"],
    ["manager", "manager"],
    ["agent", "agent"],
    ["coordinator", null],
  ] as const)("refuses a %s and writes, audits and confirms nothing", async (_label, role) => {
    who.role = role;
    await expect(setPlaceholderDayLimit(form("60"))).rejects.toBeInstanceOf(NotAuthorizedError);
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"])("lets a %s save", async (role) => {
    who.role = role;
    expect(await landing(setPlaceholderDayLimit(form("60")))).toMatch(/NEXT_REDIRECT:\/admin\/program-leads\?ok=placeholder-day-limit/);
  });

  it("saves the limit on the one settings row, audits from and to, and says it saved on its own page", async () => {
    await landing(setPlaceholderDayLimit(form(" 75 ")));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, placeholder_day_limit: 75, updated_by: "admin1" }),
      { onConflict: "id" },
    );
    expect(Object.keys(upsert.mock.calls[0]![0]).sort()).toEqual(["id", "placeholder_day_limit", "updated_at", "updated_by"]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.settings",
      details: { from: { placeholder_day_limit: 50 }, to: { placeholder_day_limit: 75 } },
    }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin/program-leads");
  });

  it.each(["0", "500"])("accepts the edge %s", async (raw) => {
    expect(await landing(setPlaceholderDayLimit(form(raw)))).toMatch(/\?ok=placeholder-day-limit/);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ placeholder_day_limit: Number(raw) }), { onConflict: "id" });
  });

  it("still saves when the old limit cannot be read, and says so in the trail", async () => {
    readProgramLeadTimesSettings.mockResolvedValueOnce(null);
    await landing(setPlaceholderDayLimit(form("40")));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: { from: { placeholder_day_limit: "unreadable" }, to: { placeholder_day_limit: 40 } },
    }));
  });

  it.each(["-1", "501", "12.5", "", "fifty", "1e2", "0x10"])("refuses %j on the server, naming what to enter, and writes nothing", async (raw) => {
    const where = decodeURIComponent(await landing(setPlaceholderDayLimit(form(raw))));
    expect(where).toContain("/admin/program-leads?error=");
    expect(where).toContain("Enter a whole number from 0 to 500.");
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a write the database refused, before any audit or confirmation", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    const where = await landing(setPlaceholderDayLimit(form("60")));
    expect(where).toMatch(/\/admin\/program-leads\?error=/);
    expect(where).not.toMatch(/ok=/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
