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
import { PHOTO_OUTCOME_CODES, photoOutcomeFromParams, photoOutcomeQuery, photoOutcomeText } from "@/lib/advisor-photos/copy";

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

// The outcome travels as a code and numbers; the page looks the words up.
const outcomeOf = (param: "photos" | "photo") => {
  const url = new URL(`https://x.test${redirectedTo()}`);
  return { path: url.pathname, outcome: photoOutcomeFromParams(Object.fromEntries(url.searchParams), param), raw: url.search };
};

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
    const { path, outcome } = outcomeOf("photos");
    expect(path).toBe("/admin/agents");
    expect(photoOutcomeText(outcome!).text).toMatch(/^Read 3 people from Google, 1 gained a photo/);
  });

  it("carries only a code and numbers, never names or words", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({
      status: "measured",
      plan: plan({ repeated: [{ sha256: "a".repeat(64), holders: ["ada@trypennie.com", "b@x", "c@x"], held: ["c@x"] }] }),
      applied: true,
      verdict: true,
    });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    const { outcome, raw } = outcomeOf("photos");
    expect(raw).not.toMatch(/@/);
    expect(raw).toMatch(/^\?photos=done(&p[a-z]=\d+)+$/);
    expect(photoOutcomeText(outcome!).ok).toBe(false);
  });

  it("says a run cut short at its deadline was cut short, with how many it never reached", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({
      status: "measured",
      plan: plan(),
      applied: true,
      verdict: false,
      deadlineReached: true,
      notReached: 40,
    });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    const { outcome, raw } = outcomeOf("photos");
    expect(outcome!.code).toBe("cut-short");
    expect(raw).toMatch(/pr=40/);
    const { ok, text } = photoOutcomeText(outcome!);
    expect(ok).toBe(false);
    expect(text).toMatch(/40 people were not reached/);
  });

  it("says why when the run was refused", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({ status: "refused", why: "no-subject", detail: "x" });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(photoOutcomeText(outcomeOf("photos").outcome!).text).toMatch(/DIRECTORY_ADMIN_SUBJECT is not set/);
  });

  it("says a run is already going rather than pretending it finished", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValue({ status: "skipped", why: "overlapping-run" });
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(photoOutcomeText(outcomeOf("photos").outcome!).text).toMatch(/already running/);
  });

  it("reports a run that threw as failed, with the reason left in the logs", async () => {
    lane.runAdvisorPhotoLane.mockRejectedValue(new Error("secret detail"));
    await expect(refreshAdvisorPhotosNow()).rejects.toThrow(/NEXT_REDIRECT:/);
    const { outcome, raw } = outcomeOf("photos");
    expect(raw).not.toMatch(/secret/);
    expect(outcome!.code).toBe("run-failed");
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
    expect(redirectedTo()).toBe("/admin/agents/u1?photo=updated");
    expect(photoOutcomeText(outcomeOf("photo").outcome!).text).toBe("Photo updated from Google.");
  });

  it("says when Google's directory does not hold the address", async () => {
    lane.refreshOnePhoto.mockResolvedValue({ status: "measured", plan: plan({ notInDirectory: ["a@x"] }), applied: true, verdict: false });
    await expect(refreshAdvisorPhotoFor(form("u1"))).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirectedTo()).toBe("/admin/agents/u1?photo=not-in-directory");
  });
});

describe("reading an outcome back from the address", () => {
  it("draws nothing for a crafted link", () => {
    expect(photoOutcomeFromParams({ photos: "Your account is locked, call 555" }, "photos")).toBeNull();
    expect(photoOutcomeFromParams({ photos: "done", pa: "3" }, "photos")).toBeNull();
    expect(photoOutcomeFromParams({ photos: "done", pa: "x", pg: "1", pc: "0", pl: "0", pu: "0", pf: "0", pm: "0", pd: "0" }, "photos")).toBeNull();
    expect(photoOutcomeFromParams({ photo: "repeated", pn: "lots" }, "photo")).toBeNull();
  });

  it("round trips every code it can write", () => {
    for (const code of PHOTO_OUTCOME_CODES) {
      const o = code === "done"
        ? { code, counts: { attempted: 1, gained: 1, changed: 0, lost: 0, unchanged: 0, failed: 0, notInDirectory: 0, deleted: 0 }, held: false }
        : code === "cut-short"
          ? { code, counts: { attempted: 1, gained: 1, changed: 0, lost: 0, unchanged: 0, failed: 0, notInDirectory: 0, deleted: 0 }, held: false, notReached: 4 }
          : code === "repeated" ? { code, holders: 3 } : { code };
      const back = photoOutcomeFromParams(Object.fromEntries(new URLSearchParams(photoOutcomeQuery(o, "photo"))), "photo");
      expect(back).toEqual(o);
      expect(photoOutcomeText(back!).text.length).toBeGreaterThan(10);
    }
  });
});
