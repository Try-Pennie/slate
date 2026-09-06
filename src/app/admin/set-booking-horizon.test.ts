import { describe, it, expect, vi, beforeEach } from "vitest";

// #216: the setBookingHorizon admin action. Behavior pinned: admin-only; validates
// the horizon against the 1..7 range (a blank clears the override); writes
// booking_settings id=1 (column-scoped upsert, so it never clobbers
// default_bucket_code); on a successful save it marks every precomputed row stale
// so the recompute lane rebuilds rows over the NEW window (refresh-on-save, the real
// convergence mechanism); records an audit entry. The failure path (out of range)
// redirects with an error and NEVER writes or invalidates. Only DB/auth/audit/next
// and the invalidation helper are mocked.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const markAllBucketSlotsStale = vi.hoisted(() => vi.fn(async () => 3));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setBookingHorizon } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("setBookingHorizon", () => {
  it("rejects a non-admin caller and never writes or invalidates", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setBookingHorizon(form({ horizon_days: "5" }))).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range value: redirects with an error, no write, no invalidate", async () => {
    await expect(setBookingHorizon(form({ horizon_days: "30" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("saves a valid horizon (id=1 upsert), refreshes rows, audits, redirects ok", async () => {
    await expect(setBookingHorizon(form({ horizon_days: "6" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=booking-horizon/,
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { onConflict: string },
    ];
    expect(row.id).toBe(1);
    expect(row.horizon_days).toBe(6);
    expect(row.updated_by).toBe("admin1");
    // Column-scoped: must NOT carry default_bucket_code (would clobber it on update).
    expect("default_bucket_code" in row).toBe(false);
    expect(opts.onConflict).toBe("id");
    expect(markAllBucketSlotsStale).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.settings", details: { horizon_days: 6 } }),
    );
  });

  // #1924 reversed this. Blank used to clear the override and write null, and the
  // field rendered EMPTY with 4 only as a placeholder, so an admin who saved
  // without typing wrote null while a grey 4 sat in the box looking like a value.
  // Dan: "if they try to save with no number, just error and don't let them."
  //
  // Replaced rather than adjusted: its whole content was the decision being
  // reversed (L252). What survives is the shape of the assertion, which is that a
  // refusal writes NOTHING.
  it("refuses a blank value, writes nothing, and refreshes nothing", async () => {
    await expect(setBookingHorizon(form({ horizon_days: "" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    // A refused save must not invalidate every bucket's slots for nothing.
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  // #1922: and the refusal reaches the page that can show it, rather than the
  // dead /admin/settings that dropped the query on its way to Health.
  it("sends the refusal to the page the form is on", async () => {
    await expect(setBookingHorizon(form({ horizon_days: "" }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/business-hours\?error=/,
    );
  });
});
