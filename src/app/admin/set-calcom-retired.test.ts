import { describe, it, expect, vi, beforeEach } from "vitest";

// #2875: the setCalcomRetired admin action, the control behind the "cal.com
// retired" switch. Behaviour pinned: admin only; writes monitor_alert_config id=1
// through a column scoped upsert, so retiring cal.com cannot clear a cooldown, a
// channel or an arming switch sharing the row; records an audit entry carrying the
// value before AND after (L529); refuses a refused write before the audit entry,
// the revalidate and the saved notice (#2379); and lands back on /admin/alerts
// with a sentence saying which way it went.
//
// Like the kill switch it posts the STATE it wants rather than toggling, so two
// admins pressing it in the same minute cannot leave it the opposite of what both
// believed (L60).
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const upsert = vi.hoisted(() =>
  vi.fn(
    async (
      _row?: unknown,
      _opts?: { onConflict: string },
    ): Promise<{ error: { message: string; code?: string } | null }> => ({ error: null }),
  ),
);
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const retirement = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<boolean | null> => false),
  reset: vi.fn(),
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/calcom/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/calcom/retirement")>()),
  loadCalcomRetired: retirement.load,
  __resetCalcomRetiredCache: retirement.reset,
}));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setCalcomRetired } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function landing(p: Promise<void>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  if (!err) throw new Error("expected a redirect");
  return err.message;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  retirement.load.mockResolvedValue(false);
});

describe("setCalcomRetired", () => {
  it("rejects a non-admin caller and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setCalcomRetired(form({ retired: "true" }))).rejects.toThrow("Not authorized");
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("retires cal.com, writing only its own column on id=1", async () => {
    const url = await landing(setCalcomRetired(form({ retired: "true" })));
    expect(from).toHaveBeenCalledWith("monitor_alert_config");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.calcom_retired).toBe(true);
    expect(row.updated_by).toBe("admin1");
    expect(opts.onConflict).toBe("id");
    // The neighbours on this single row must not be touched.
    for (const k of ["low_volume_armed", "alerts_channel", "floor_30", "volume_ramp_end_on"]) {
      expect(row).not.toHaveProperty(k);
    }
    expect(url).toContain("/admin/alerts");
    expect(url).toContain("ok=calcom-retired");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/alerts");
    // The cached answer the lanes read is dropped, so this isolate acts on it now.
    expect(retirement.reset).toHaveBeenCalled();
  });

  it("puts cal.com back, and says so with its own sentence", async () => {
    retirement.load.mockResolvedValue(true);
    const url = await landing(setCalcomRetired(form({ retired: "false" })));
    const [row] = upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.calcom_retired).toBe(false);
    expect(url).toContain("ok=calcom-live");
  });

  it("records the value before and after, not merely that it was touched", async () => {
    await landing(setCalcomRetired(form({ retired: "true" })));
    const entry = recordAudit.mock.calls[0]?.[0] as unknown as { action: string; details: Record<string, unknown> };
    expect(entry.action).toBe("monitor.calcom_retired");
    expect(entry.details).toEqual({ from: false, to: true });
  });

  it("records an unreadable before value as unknown rather than guessing it", async () => {
    retirement.load.mockResolvedValue(null);
    await landing(setCalcomRetired(form({ retired: "true" })));
    const entry = recordAudit.mock.calls[0]?.[0] as unknown as { details: Record<string, unknown> };
    expect(entry.details).toEqual({ from: null, to: true });
  });

  // A stray or malformed submit must not retire cal.com: that stops every cal.com
  // write while cal.com may still be taking every lead. Only an explicit "true".
  it("treats anything that is not an explicit true as live", async () => {
    await landing(setCalcomRetired(form({})));
    const [row] = upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.calcom_retired).toBe(false);
  });

  it("refuses a refused write: no audit entry, no revalidate, no saved notice", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "column calcom_retired does not exist", code: "42703" } });
    const url = await landing(setCalcomRetired(form({ retired: "true" })));
    expect(url).not.toContain("ok=");
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/retire cal\.com/i);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
