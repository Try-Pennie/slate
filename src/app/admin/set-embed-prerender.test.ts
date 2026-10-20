import { describe, it, expect, vi, beforeEach } from "vitest";

// #3706: the setEmbedPrerender admin action, the switch behind building Slate's booker as
// a partner page loads. Built the way the frame lock's is (#3137): admin only; a column
// scoped upsert on booking_settings id=1 so it cannot clobber the lock, the pause or the
// horizon; the STATE it wants rather than a toggle (L60); an audit entry carrying which
// way it went (L529); a refused write that never reports a save (#2379); and the outcome
// on the page the form is on (L608).
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

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setEmbedPrerender } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

const fails = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  );

describe("setEmbedPrerender", () => {
  it("rejects a non-admin caller and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setEmbedPrerender(form({ on: "true" }))).rejects.toThrow("Not authorized");
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("turns it on, writing only its own column on id=1, audits it, and says so on the Embedding page", async () => {
    const err = await fails(setEmbedPrerender(form({ on: "true" })));
    expect(err?.message).toBe("NEXT_REDIRECT:/admin/embedding?ok=prerender-on");
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.embed_prerender_enabled).toBe(true);
    expect(row.updated_by).toBe("admin1");
    expect(opts.onConflict).toBe("id");
    for (const neighbour of ["frame_lock_enabled", "public_booking_paused", "default_bucket_code", "horizon_days"]) {
      expect(row).not.toHaveProperty(neighbour);
    }
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]?.[0]).toMatchObject({
      orgId: "o1",
      actorId: "admin1",
      action: "booking.settings",
      details: { embed_prerender_enabled: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/embedding");
  });

  it("turns it off, and anything that is not an explicit true turns it off", async () => {
    for (const entries of [{ on: "false" }, {}, { on: "yes" }] as Record<string, string>[]) {
      upsert.mockClear();
      const err = await fails(setEmbedPrerender(form(entries)));
      expect(err?.message).toBe("NEXT_REDIRECT:/admin/embedding?ok=prerender-off");
      expect((upsert.mock.calls[0] as unknown as [Record<string, unknown>])[0].embed_prerender_enabled).toBe(false);
    }
  });

  it("refuses a refused write in either direction: no audit entry, no saved notice", async () => {
    for (const on of ["true", "false"]) {
      recordAudit.mockClear();
      revalidatePath.mockClear();
      upsert.mockResolvedValueOnce({ error: { message: "permission denied", code: "42501" } });
      const err = await fails(setEmbedPrerender(form({ on })));
      expect(err?.message).toContain("/admin/embedding");
      expect(err?.message).not.toContain("ok=");
      expect(err?.message).toContain("error=");
      expect(recordAudit).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    }
  });
});
