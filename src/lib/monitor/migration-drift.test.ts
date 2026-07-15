import { describe, expect, it, vi, beforeEach } from "vitest";

// The DB read behind the prod lag check (#516, #814). The pure classifier and the
// runner are covered node-natively (scripts/test-migration-drift.ts); this file
// exists for the one piece that needs module mocking: the RPC call itself.
//
// The failure path is the point. A read that fails must THROW so the runner
// classifies it as "unverified" and pages. If it swallowed the error and returned
// null-as-if-fine, or returned a set it never actually read, prod would look in
// sync while its schema was behind, which is the exact bug this alert exists to
// catch. The read now returns the FULL applied set (#814), so a non-array result
// (the pre-0072 scalar function still in place) is itself a fail-loud signal.
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc }),
}));

import { readAppliedMigrationVersions } from "@/lib/monitor/migration-drift";

describe("readAppliedMigrationVersions", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns the applied version set the database reports", async () => {
    rpc.mockResolvedValue({ data: ["0001", "0002", "0071"], error: null });
    await expect(readAppliedMigrationVersions()).resolves.toEqual(["0001", "0002", "0071"]);
    expect(rpc).toHaveBeenCalledWith("applied_migration_versions");
  });

  it("throws when the RPC errors, so the caller reports unverified rather than in sync", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "function applied_migration_versions() does not exist" },
    });
    await expect(readAppliedMigrationVersions()).rejects.toThrow(/does not exist/);
  });

  it("throws when the RPC rejects outright (network or auth failure)", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"));
    await expect(readAppliedMigrationVersions()).rejects.toThrow(/fetch failed/);
  });

  it("throws when the result is not an array (pre-0072 scalar function still live)", async () => {
    // The migration that returns the set has not been applied yet, so the old
    // scalar function answered. That IS the drift: refuse to treat it as in sync.
    rpc.mockResolvedValue({ data: "0071", error: null });
    await expect(readAppliedMigrationVersions()).rejects.toThrow(/did not return an array/i);
  });

  it("throws when the database returns an empty set", async () => {
    // schema_migrations cannot really be empty on a real project, so an empty
    // array means the read did not do what we think it did. Refuse to call that
    // "in sync": surface it as unverifiable.
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(readAppliedMigrationVersions()).rejects.toThrow(/no applied migration versions/i);
  });
});
