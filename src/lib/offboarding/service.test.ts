import { describe, it, expect, vi, beforeEach } from "vitest";

// #278: the offboarding service now flips by user id (for the admin UI action)
// as well as by email (for the automation API), sharing one idempotent core.
// The write must set deactivated_at to a timestamp on deactivate and null on
// reactivate, and be a no-op when the row is already in the target state.
// Supabase is mocked; the pure planLifecycleChange is exercised for real.

const updates: Array<{ col: string; val: string; patch: { deactivated_at: string | null } }> = [];
let row: { id: string; deactivated_at: string | null } | null = null;
let lastLookup: { col: string; val: string } | null = null;
let selectError: { message: string } | null = null;
let updateError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          lastLookup = { col, val };
          return {
            maybeSingle: async () => ({ data: selectError ? null : row, error: selectError }),
          };
        },
      }),
      update: (patch: { deactivated_at: string | null }) => ({
        eq: async (col: string, val: string) => {
          updates.push({ col, val, patch });
          return { error: updateError };
        },
      }),
    }),
  }),
}));

import { applyLifecycleByEmail, applyLifecycleByUserId } from "./service";

beforeEach(() => {
  updates.length = 0;
  row = null;
  lastLookup = null;
  selectError = null;
  updateError = null;
});

describe("applyLifecycleByUserId", () => {
  it("looks up by id and deactivates an active user (sets a timestamp)", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "deactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u1", deactivate: true });
    expect(lastLookup).toEqual({ col: "id", val: "u1" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ col: "id", val: "u1" });
    expect(typeof updates[0].patch.deactivated_at).toBe("string");
  });

  it("reactivates a deactivated user (clears the timestamp)", async () => {
    row = { id: "u1", deactivated_at: "2026-01-01T00:00:00Z" };
    const res = await applyLifecycleByUserId("u1", "reactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u1", deactivate: false });
    expect(updates[0].patch.deactivated_at).toBeNull();
  });

  it("is an idempotent no-op when already in the target state (no write)", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "reactivate");
    expect(res).toMatchObject({ status: "noop", userId: "u1" });
    expect(updates).toHaveLength(0);
  });

  it("returns not_found for an unknown id and writes nothing", async () => {
    row = null;
    const res = await applyLifecycleByUserId("ghost", "deactivate");
    expect(res).toEqual({ status: "not_found" });
    expect(updates).toHaveLength(0);
  });
});

// Fail loud. Both reads and the write used to ignore their `error`, so a
// deactivate that never happened returned `status: "applied"`. Everything
// downstream believes that word: the admin page says the agent is deactivated,
// the offboarding automation records the offboarding as done, and the agent keeps
// taking bookings. A silent no-op here is worse than an error, because nobody
// looks again.
describe("a lifecycle write that failed never reports success (#1215)", () => {
  it("throws when the update errors instead of claiming applied", async () => {
    row = { id: "u1", deactivated_at: null };
    updateError = { message: "permission denied for table users" };
    await expect(applyLifecycleByUserId("u1", "deactivate")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("throws when the lookup errors instead of claiming not_found", async () => {
    row = { id: "u1", deactivated_at: null };
    selectError = { message: "column users.deactivated_at does not exist" };
    await expect(applyLifecycleByUserId("u1", "deactivate")).rejects.toThrow(
      /does not exist/,
    );
    expect(updates).toHaveLength(0);
  });

  // Same for the automation path, which is the one with no human watching.
  it("throws on the by-email path too", async () => {
    row = { id: "u9", deactivated_at: null };
    updateError = { message: "deadlock detected" };
    await expect(applyLifecycleByEmail("leaver@trypennie.com", "deactivate")).rejects.toThrow(
      /deadlock detected/,
    );
  });
});

describe("applyLifecycleByEmail still works through the shared core", () => {
  it("looks up by email and deactivates", async () => {
    row = { id: "u9", deactivated_at: null };
    const res = await applyLifecycleByEmail(" leaver@trypennie.com ", "deactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u9", deactivate: true });
    expect(lastLookup).toEqual({ col: "email", val: "leaver@trypennie.com" });
  });
});
