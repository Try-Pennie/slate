import { describe, it, expect, vi, beforeEach } from "vitest";

// #2297: the setPublicBookingPaused admin action, the control behind the kill
// switch. Behaviour pinned: admin-only; writes booking_settings id=1 through a
// column-scoped upsert so it can never clobber default_bucket_code or horizon_days;
// records an audit entry carrying WHICH WAY it was moved, because "somebody changed
// the booking switch" cannot answer the only question anybody asks afterwards
// (L529); and redirects back to the screen the control is on.
//
// The value is read from the form as an explicit state rather than as a toggle of
// whatever is currently stored. A toggle would make two people pressing it in the
// same minute leave bookings OPEN while both believed they had stopped them, and
// it is a control whose whole purpose is being certain (L60).
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
const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
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

import { setPublicBookingPaused } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("setPublicBookingPaused", () => {
  it("rejects a non-admin caller and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setPublicBookingPaused(form({ paused: "true" }))).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stops public bookings, writing only its own column on id=1", async () => {
    await expect(setPublicBookingPaused(form({ paused: "true" }))).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, { onConflict: string }];
    expect(row.id).toBe(1);
    expect(row.public_booking_paused).toBe(true);
    expect(opts.onConflict).toBe("id");
    // The neighbours on this single row must not be touched, or pausing bookings
    // would also clear the default bucket and the horizon.
    expect(row).not.toHaveProperty("default_bucket_code");
    expect(row).not.toHaveProperty("horizon_days");
  });

  it("starts them again", async () => {
    await expect(setPublicBookingPaused(form({ paused: "false" }))).rejects.toThrow(/NEXT_REDIRECT:/);
    const [row] = upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.public_booking_paused).toBe(false);
  });

  // The audit entry has to say which way it went. A record that only says the
  // switch was touched cannot answer "were we taking bookings at 3am" (L529).
  it("records which way it was moved, not merely that it was moved", async () => {
    await expect(setPublicBookingPaused(form({ paused: "true" }))).rejects.toThrow(/NEXT_REDIRECT:/);
    const pausedAudit = recordAudit.mock.calls[0]?.[0] as unknown as { details: Record<string, unknown> };
    expect(pausedAudit.details.public_booking_paused).toBe(true);

    recordAudit.mockClear();
    await expect(setPublicBookingPaused(form({ paused: "false" }))).rejects.toThrow(/NEXT_REDIRECT:/);
    const openedAudit = recordAudit.mock.calls[0]?.[0] as unknown as { details: Record<string, unknown> };
    expect(openedAudit.details.public_booking_paused).toBe(false);
  });

  // A missing or unreadable field must not be read as "stop taking bookings", which
  // is the expensive direction: a stray submit would take the booker down. Only an
  // explicit "true" pauses.
  it("treats anything that is not an explicit true as open", async () => {
    await expect(setPublicBookingPaused(form({}))).rejects.toThrow(/NEXT_REDIRECT:/);
    const [row] = upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.public_booking_paused).toBe(false);
  });
});
