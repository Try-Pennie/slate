import { describe, it, expect, vi, beforeEach } from "vitest";

// #4380: setTransferOfferSettings, the live transfer settings on /admin/coordinator-booking: how
// many advisors must be free before the coordinator page offers "Transfer now", and the line the
// customer is transferred to. SUPER ADMIN only, checked by the action itself rather than trusted
// to the page; a refusal names what to enter and writes nothing; a column scoped upsert on
// booking_settings id=1; an audit entry with the values it replaced and the values it became;
// a refused write never audits, invalidates or confirms.
const auth = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(async () => ({ id: "sa1", role: "super_admin", org_id: "o1" })),
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const upsert = vi.hoisted(() => vi.fn(async (_row: Record<string, unknown>, _opts: { onConflict: string }) => ({ error: null as { message: string } | null })));
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const readTransferOfferSettings = vi.hoisted(() => vi.fn(async (): Promise<{ threshold: number; line: string } | null> => ({ threshold: 3, line: "786-504-0671" })));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/booking/settings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/booking/settings")>()), readTransferOfferSettings }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setTransferOfferSettings } from "./actions";

const PAGE = "/admin/coordinator-booking";
const form = (threshold: string, line: string) => {
  const fd = new FormData();
  fd.set("transfer_offer_threshold", threshold);
  fd.set("transfer_line", line);
  return fd;
};
const landing = (run: Promise<unknown>) => run.then(() => "", (e: unknown) => String(e));

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSuperAdmin.mockResolvedValue({ id: "sa1", role: "super_admin", org_id: "o1" });
  readTransferOfferSettings.mockResolvedValue({ threshold: 3, line: "786-504-0671" });
  upsert.mockResolvedValue({ error: null });
});

describe("setTransferOfferSettings (#4380)", () => {
  it("refuses anybody but a super admin and writes nothing", async () => {
    auth.requireSuperAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setTransferOfferSettings(form("4", "212-555-0100"))).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("saves both on the one settings row, audits from and to, and says it saved on the page it was pressed on", async () => {
    expect(await landing(setTransferOfferSettings(form(" 4 ", "212-555-0100")))).toMatch(new RegExp(`NEXT_REDIRECT:${PAGE}\\?ok=transfer-offer`));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, transfer_offer_threshold: 4, transfer_line: "212-555-0100", updated_by: "sa1" }),
      { onConflict: "id" },
    );
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.settings",
      details: { from: { transfer_offer_threshold: 3, transfer_line: "786-504-0671" }, to: { transfer_offer_threshold: 4, transfer_line: "212-555-0100" } },
    }));
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it("still saves when the old values cannot be read, and says so in the trail", async () => {
    readTransferOfferSettings.mockResolvedValueOnce(null);
    await landing(setTransferOfferSettings(form("5", "786-504-0671")));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { from: "unreadable", to: { transfer_offer_threshold: 5, transfer_line: "786-504-0671" } } }));
  });

  it.each([
    ["0", "786-504-0671", "Enter a whole number of advisors from 1 to 100."],
    ["3", "7865040671", "Enter the transfer line as 786-504-0671."],
  ])("refuses %j and %j, naming what to enter, and writes nothing", async (threshold, line, sentence) => {
    expect(decodeURIComponent(await landing(setTransferOfferSettings(form(threshold, line))))).toContain(sentence);
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a write the database refused, before any audit or confirmation", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    const where = await landing(setTransferOfferSettings(form("4", "212-555-0100")));
    expect(where).toMatch(/\?error=/);
    expect(where).not.toMatch(/ok=/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
