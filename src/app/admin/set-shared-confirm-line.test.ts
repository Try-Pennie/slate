import { describe, it, expect, vi, beforeEach } from "vitest";

// #3325: the setSharedConfirmLine admin action, the switch behind the shared confirm line.
// Built the way the frame lock (#3137) and the public booking pause (#2297) are: admin
// only; a column scoped upsert on booking_settings id=1 so it cannot clobber the pause,
// the frame lock, the horizon or the default bucket; the STATE it wants rather than a
// toggle (L60); an audit entry carrying which way it went (L529); a refused write that
// never reports a save (#2379); and the outcome named on the page the form is on.
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
// Typed with the result shape supabase-js really returns, so a test can drive a
// REFUSED write (#2379).
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

import { setSharedConfirmLine } from "./actions";

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

describe("setSharedConfirmLine", () => {
  it("rejects a non-admin caller and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setSharedConfirmLine(form({ on: "true" }))).rejects.toThrow("Not authorized");
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("turns the line on, writing only its own column on id=1, and says so on the Hours page", async () => {
    const err = await fails(setSharedConfirmLine(form({ on: "true" })));
    expect(err?.message).toBe("NEXT_REDIRECT:/admin/business-hours?ok=shared-line-on");
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.shared_confirm_line).toBe(true);
    expect(row.updated_by).toBe("admin1");
    expect(opts.onConflict).toBe("id");
    for (const neighbour of ["public_booking_paused", "frame_lock_enabled", "default_bucket_code", "horizon_days"]) {
      expect(row).not.toHaveProperty(neighbour);
    }
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]?.[0]).toMatchObject({
      orgId: "o1",
      actorId: "admin1",
      action: "booking.settings",
      details: { shared_confirm_line: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/business-hours");
  });

  it("turns it off, and anything that is not an explicit true turns it off", async () => {
    for (const entries of [{ on: "false" }, {}, { on: "yes" }, { on: "TRUE" }] as Record<string, string>[]) {
      upsert.mockClear();
      recordAudit.mockClear();
      const err = await fails(setSharedConfirmLine(form(entries)));
      expect(err?.message).toBe("NEXT_REDIRECT:/admin/business-hours?ok=shared-line-off");
      expect((upsert.mock.calls[0] as unknown as [Record<string, unknown>])[0].shared_confirm_line).toBe(false);
      expect((recordAudit.mock.calls[0]?.[0] as { details: Record<string, unknown> }).details).toEqual({
        shared_confirm_line: false,
      });
    }
  });

  it("refuses a refused write in either direction: no audit entry, no saved notice, no revalidation", async () => {
    for (const on of ["true", "false"]) {
      recordAudit.mockClear();
      revalidatePath.mockClear();
      upsert.mockResolvedValueOnce({ error: { message: "permission denied", code: "42501" } });
      const err = await fails(setSharedConfirmLine(form({ on })));
      expect(err?.message).toContain("/admin/business-hours");
      expect(err?.message).not.toContain("ok=");
      expect(err?.message).toContain("error=");
      // Which way it was going stays in the refusal, because that is the one thing the
      // person who pressed it needs to know (L60).
      expect(decodeURIComponent(err?.message ?? "")).toContain(on === "true" ? "turn the shared confirm line on" : "turn the shared confirm line off");
      expect(recordAudit).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    }
  });
});
