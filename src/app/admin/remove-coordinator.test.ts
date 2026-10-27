import { describe, it, expect, vi, beforeEach } from "vitest";

// #4264: removeCoordinator, the Remove beside each coordinator on /admin/coordinator-booking
// (D11, D12 in docs/design/coordinator-admin.html).
//
// Team access GRANTS access and never takes it away; a staff member's access is removed today
// by departing them (`setUserLifecycle` -> `applyLifecycleByUserId(id, "deactivate")`), which
// stamps `deactivated_at` and clears `bookable` in one statement through `writeRoutableState`
// and bans the Supabase sign in. Remove goes through that same path, so a removed coordinator is
// refused by the session gate on their very next request (`gateSessionRow`) and at sign in, and
// keeps the coordinator role, so they never become an advisor. Their booked calls are on the
// advisors they booked them with and stay, so no coverage sweep is asked for.
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
type Target = { id: string; org_id: string; role: string; name: string | null; email: string; deactivated_at: string | null };
const target = vi.hoisted(() => ({
  row: null as Target | null,
  error: null as { message: string; code?: string } | null,
}));
const eq = vi.hoisted(() => vi.fn());
const select = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const lifecycle = vi.hoisted(() => ({
  applyLifecycleByUserId: vi.fn(),
  applyLifecycleByEmail: vi.fn(),
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => lifecycle);
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { removeCoordinator } from "./actions";

const PAGE = "/admin/coordinator-booking";
const aisha: Target = { id: "c1", org_id: "o1", role: "coordinator", name: "Aisha Bello", email: "abello@trypennie.com", deactivated_at: null };

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const fails = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSuperAdmin.mockResolvedValue({ id: "sa1", role: "super_admin", org_id: "o1" });
  target.row = { ...aisha };
  target.error = null;
  from.mockImplementation(() => ({ select }));
  select.mockImplementation(() => ({ eq }));
  eq.mockImplementation(() => ({ maybeSingle: async () => ({ data: target.row, error: target.error }) }));
  lifecycle.applyLifecycleByUserId.mockResolvedValue({ status: "applied", userId: "c1", deactivate: true, sessionRevoke: "revoked" });
});

describe("removeCoordinator", () => {
  it("refuses anybody below super admin, an admin included, and changes nothing", async () => {
    auth.requireSuperAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(removeCoordinator(form({ user_id: "c1" }))).rejects.toThrow("Not authorized");
    expect(auth.requireAdmin).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(lifecycle.applyLifecycleByUserId).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("removes through the departure path, audits it, refreshes the page and says so there", async () => {
    const err = await fails(removeCoordinator(form({ user_id: "c1" })));
    expect(err?.message).toBe(`NEXT_REDIRECT:${PAGE}?ok=coordinator-removed`);
    expect(from).toHaveBeenCalledWith("users");
    expect(eq).toHaveBeenCalledWith("id", "c1");
    // The one path that departs a person: no coverage sweep, since a coordinator holds no calls.
    expect(lifecycle.applyLifecycleByUserId).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyLifecycleByUserId).toHaveBeenCalledWith("c1", "deactivate");
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]?.[0]).toMatchObject({
      orgId: "o1",
      actorId: "sa1",
      action: "agent.deactivate",
      targetUserId: "c1",
      details: { deactivated: { from: false, to: true }, role: "coordinator", via: "coordinator_booking" },
    });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it("records a ban that did not land, since the session gate still refuses them", async () => {
    lifecycle.applyLifecycleByUserId.mockResolvedValueOnce({ status: "applied", userId: "c1", deactivate: true, sessionRevoke: "failed" });
    await fails(removeCoordinator(form({ user_id: "c1" })));
    expect((recordAudit.mock.calls[0]?.[0] as { details: Record<string, unknown> }).details).toMatchObject({ session_revoke: "failed" });
  });

  it("refuses a failed write by name: no audit entry, no saved notice, no revalidation", async () => {
    lifecycle.applyLifecycleByUserId.mockRejectedValueOnce(new Error("offboarding deactivate failed for user c1: permission denied"));
    const err = await fails(removeCoordinator(form({ user_id: "c1" })));
    const said = decodeURIComponent(err?.message ?? "");
    expect(said).toContain(`${PAGE}?error=`);
    expect(said).not.toContain("ok=");
    expect(said).toContain("Removing Aisha Bello could not be saved");
    expect(said).toContain("permission denied");
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses when it cannot read who that is, and never guesses", async () => {
    target.row = null;
    target.error = { message: "timeout" };
    const err = await fails(removeCoordinator(form({ user_id: "c1" })));
    const said = decodeURIComponent(err?.message ?? "");
    expect(said).toContain(`${PAGE}?error=`);
    expect(said).toContain("nobody's access changed");
    expect(lifecycle.applyLifecycleByUserId).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("removes only a coordinator in the caller's own organisation", async () => {
    for (const row of [
      null,
      { ...aisha, role: "agent" },
      { ...aisha, role: "admin" },
      { ...aisha, org_id: "o2" },
    ] as (Target | null)[]) {
      lifecycle.applyLifecycleByUserId.mockClear();
      target.row = row;
      const err = await fails(removeCoordinator(form({ user_id: "c1" })));
      expect(decodeURIComponent(err?.message ?? "")).toContain("is not a coordinator here, so nothing was changed");
      expect(lifecycle.applyLifecycleByUserId).not.toHaveBeenCalled();
    }
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a form that names nobody, before any read", async () => {
    const err = await fails(removeCoordinator(form({})));
    expect(decodeURIComponent(err?.message ?? "")).toContain(`${PAGE}?error=`);
    expect(from).not.toHaveBeenCalled();
  });

  it("writes no second audit entry for somebody already removed", async () => {
    lifecycle.applyLifecycleByUserId.mockResolvedValueOnce({ status: "noop", userId: "c1", sessionRevoke: "revoked" });
    const err = await fails(removeCoordinator(form({ user_id: "c1" })));
    expect(err?.message).toBe(`NEXT_REDIRECT:${PAGE}?ok=coordinator-removed`);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
