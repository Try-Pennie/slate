import { describe, it, expect, vi, beforeEach } from "vitest";

// #4264: setPlaceholderBookingEnabled, the switch behind "Coordinator calls nobody is free for"
// on /admin/coordinator-booking. Built the way the shared confirm line (#3325) and the frame lock
// (#3137) are, but SUPER ADMIN only, checked by the action itself rather than trusted to the page
// (D2 in docs/design/coordinator-admin.html): a column scoped upsert on booking_settings id=1, the
// STATE it wants rather than a toggle (L60), an audit entry carrying which way it went (L529), a
// refused write that never reports a save (#2379), and the outcome named on the page it is on.
const auth = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(async () => ({ id: "sa1", role: "super_admin", org_id: "o1" })),
  requireAdmin: vi.fn(),
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

import { setPlaceholderBookingEnabled } from "./actions";

const PAGE = "/admin/coordinator-booking";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSuperAdmin.mockResolvedValue({ id: "sa1", role: "super_admin", org_id: "o1" });
});

const fails = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  );

describe("setPlaceholderBookingEnabled", () => {
  it("refuses anybody below super admin, an admin included, and never writes", async () => {
    auth.requireSuperAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setPlaceholderBookingEnabled(form({ on: "true" }))).rejects.toThrow("Not authorized");
    expect(auth.requireSuperAdmin).toHaveBeenCalledTimes(1);
    // The admin gate is not the one consulted: an admin passing it must not reach the write.
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("turns it on, writing only its own column on id=1, audits it and says so on its page", async () => {
    const err = await fails(setPlaceholderBookingEnabled(form({ on: "true" })));
    expect(err?.message).toBe(`NEXT_REDIRECT:${PAGE}?ok=placeholder-on`);
    expect(from).toHaveBeenCalledWith("booking_settings");
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.placeholder_booking_enabled).toBe(true);
    expect(row.updated_by).toBe("sa1");
    expect(opts.onConflict).toBe("id");
    for (const neighbour of ["public_booking_paused", "shared_confirm_line", "frame_lock_enabled", "default_bucket_code"]) {
      expect(row).not.toHaveProperty(neighbour);
    }
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]?.[0]).toMatchObject({
      orgId: "o1",
      actorId: "sa1",
      action: "booking.settings",
      details: { placeholder_booking_enabled: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it("turns it off, and anything that is not an explicit true turns it off", async () => {
    for (const entries of [{ on: "false" }, {}, { on: "yes" }, { on: "TRUE" }] as Record<string, string>[]) {
      upsert.mockClear();
      recordAudit.mockClear();
      const err = await fails(setPlaceholderBookingEnabled(form(entries)));
      expect(err?.message).toBe(`NEXT_REDIRECT:${PAGE}?ok=placeholder-off`);
      expect((upsert.mock.calls[0] as unknown as [Record<string, unknown>])[0].placeholder_booking_enabled).toBe(false);
      expect((recordAudit.mock.calls[0]?.[0] as { details: Record<string, unknown> }).details).toEqual({
        placeholder_booking_enabled: false,
      });
    }
  });

  it("refuses a refused write by name in either direction: no audit entry, no saved notice, no revalidation", async () => {
    for (const on of ["true", "false"]) {
      recordAudit.mockClear();
      revalidatePath.mockClear();
      upsert.mockResolvedValueOnce({ error: { message: "column does not exist", code: "42703" } });
      const err = await fails(setPlaceholderBookingEnabled(form({ on })));
      expect(err?.message).toContain(PAGE);
      expect(err?.message).not.toContain("ok=");
      const said = decodeURIComponent(err?.message ?? "");
      // Which way it was going, in the button's own words, and the database's reason.
      expect(said).toContain(on === "true" ? "let coordinators book on Marcia" : "stop booking them on Marcia");
      expect(said).toContain("could not be saved: column does not exist");
      expect(recordAudit).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    }
  });
});
