import { describe, it, expect, vi, beforeEach } from "vitest";

// #3027: the two admin photo refreshes. Pinned: admins only, checked on the
// server before anything runs; each reports what happened back to the page it was
// pressed on (L608); and the roster wide one never puts a name in the address.
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
// REFUSED write. Typed as `{ error: null }` it could only ever resolve one way,
// and the one case worth having here would not compile (#2379).
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

const lane = vi.hoisted(() => ({
  runAdvisorPhotoLane: vi.fn(),
  refreshOnePhoto: vi.fn(),
}));
vi.mock("@/lib/advisor-photos/lane", () => lane);
import { refreshAdvisorPhotoFor, refreshAdvisorPhotosNow } from "./actions";

const plan = (over: Record<string, unknown> = {}) => ({
  full: [], touch: [], failed: [], failedNeverRead: [], deleteIds: [], flipGuardTripped: false,
  heldNone: [], repeated: [], notInDirectory: [], streaks: [],
  counts: { attempted: 3, photo: 2, none: 1, placeholder: 0, notInDirectory: 0, failed: 0, gained: 1, lost: 0, changed: 0, unchanged: 2, deleted: 0 },
  ...over,
});
const redirectedTo = () => decodeURIComponent(String(redirect.mock.calls[0]?.[0] ?? ""));

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("refreshAdvisorPhotosNow", () => {
  it("refuses a caller who is not an admin before running anything", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow("Not authorized");
    expect(lane.runAdvisorPhotoLane).not.toHaveBeenCalled();
  });

  it("runs the lane as a manual trigger and reports counts back to the roster", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({ status: "measured", plan: plan(), applied: true, verdict: true });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(lane.runAdvisorPhotoLane).toHaveBeenCalledWith("manual");
    expect(redirectedTo()).toMatch(/^\/admin\/agents\?photos=Read 3 people from Google, 1 gained a photo/);
  });

  it("never names anybody in the address, even when people were held", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({
      status: "measured",
      plan: plan({ repeated: [{ sha256: "a".repeat(64), holders: ["ada@trypennie.com", "b@x", "c@x"], held: ["c@x"] }] }),
      applied: true,
      verdict: true,
    });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirectedTo()).toMatch(/photos_error=/);
    expect(redirectedTo()).not.toMatch(/@/);
  });

  it("says why when the run was refused", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({ status: "refused", why: "no-subject", detail: "x" });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirectedTo()).toMatch(/photos_error=DIRECTORY_ADMIN_SUBJECT is not set/);
  });

  it("says a run is already going rather than pretending it finished", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({ status: "skipped", why: "overlapping-run" });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirectedTo()).toMatch(/photos_error=A photo refresh is already running/);
  });
});

describe("refreshAdvisorPhotoFor", () => {
  const form = (id: string) => {
    const fd = new FormData();
    fd.set("user_id", id);
    return fd;
  };

  it("refuses a caller who is not an admin before running anything", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(refreshAdvisorPhotoFor(form("u1"))).rejects.toThrow("Not authorized");
    expect(lane.refreshOnePhoto).not.toHaveBeenCalled();
  });

  it("refreshes that one person and reports back to their page", async () => {
    lane.refreshOnePhoto.mockResolvedValue({
      status: "measured",
      plan: plan({ counts: { ...plan().counts, attempted: 1, gained: 1 } }),
      applied: true,
      verdict: false,
    });
    await expect(refreshAdvisorPhotoFor(form("u1"))).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(lane.refreshOnePhoto).toHaveBeenCalledWith("u1");
    expect(redirectedTo()).toBe("/admin/agents/u1?photo=Photo updated from Google.");
  });

  it("says when Google's directory does not hold the address", async () => {
    lane.refreshOnePhoto.mockResolvedValue({ status: "measured", plan: plan({ notInDirectory: ["a@x"] }), applied: true, verdict: false });
    await expect(refreshAdvisorPhotoFor(form("u1"))).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirectedTo()).toMatch(/photo_error=Google's directory does not hold this address/);
  });
});
