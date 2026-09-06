import { describe, it, expect, vi, beforeEach } from "vitest";

// #1016: the setDefaultBucket admin action. Behavior pinned: it validates the
// chosen code against the CURRENT non-test bucket codes (so a code pointing at no
// bucket can never be saved), writes booking_settings id=1 on a valid choice or a
// blank (which clears the default), and records an audit entry. The failure path
// (an unknown code) must redirect with an error and NEVER write. Only the DB
// client, auth, audit, and next/* are mocked.
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
const bucketRows = vi.hoisted(() => ({ data: [] as { code: string }[] }));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    if (table === "buckets") {
      const q: Record<string, unknown> = {
        select: vi.fn(() => q),
        eq: vi.fn(() => Promise.resolve(bucketRows)),
        order: vi.fn(() => Promise.resolve(bucketRows)),
      };
      return q;
    }
    return { upsert };
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setDefaultBucket } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  bucketRows.data = [{ code: "100" }, { code: "200" }];
});

describe("setDefaultBucket", () => {
  it("rejects a non-admin caller and never writes", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setDefaultBucket(form({ default_bucket_code: "100" }))).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses an unknown bucket code: redirects with an error and does NOT write", async () => {
    await expect(setDefaultBucket(form({ default_bucket_code: "999" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("saves a valid code (id=1 upsert + audit) and redirects ok", async () => {
    await expect(setDefaultBucket(form({ default_bucket_code: "200" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=bucket-routing/,
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { onConflict: string },
    ];
    expect(row.id).toBe(1);
    expect(row.default_bucket_code).toBe("200");
    expect(row.updated_by).toBe("admin1");
    expect(opts.onConflict).toBe("id");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.settings", details: { default_bucket_code: "200" } }),
    );
  });

  it("clears the default when the choice is blank (writes null)", async () => {
    await expect(setDefaultBucket(form({ default_bucket_code: "" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=bucket-routing/,
    );
    const [row] = upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.default_bucket_code).toBeNull();
  });
});
