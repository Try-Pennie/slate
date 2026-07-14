import { describe, expect, it, vi, beforeEach } from "vitest";

// The DB read behind the prod lag check (#516). The pure classifier and the
// runner are covered node-natively (scripts/test-migration-drift.ts); this file
// exists for the one piece that needs module mocking: the RPC call itself.
//
// The failure path is the point. A read that fails must THROW so the runner
// classifies it as "unverified" and pages. If it swallowed the error and returned
// null-as-if-fine, or returned a version it never actually read, prod would look
// in sync while its schema was behind, which is the exact bug this alert exists
// to catch.
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc }),
}));

import { readAppliedMigrationVersion } from "@/lib/monitor/migration-drift";

describe("readAppliedMigrationVersion", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns the version the database reports", async () => {
    rpc.mockResolvedValue({ data: "0071", error: null });
    await expect(readAppliedMigrationVersion()).resolves.toBe("0071");
    expect(rpc).toHaveBeenCalledWith("applied_migration_version");
  });

  it("throws when the RPC errors, so the caller reports unverified rather than in sync", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "function applied_migration_version() does not exist" },
    });
    await expect(readAppliedMigrationVersion()).rejects.toThrow(/does not exist/);
  });

  it("throws when the RPC rejects outright (network or auth failure)", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"));
    await expect(readAppliedMigrationVersion()).rejects.toThrow(/fetch failed/);
  });

  it("throws when the database returns no version at all", async () => {
    // An empty schema_migrations table cannot happen on a real project, so a null
    // here means the read did not do what we think it did. Refuse to call that
    // "in sync": surface it as unverifiable.
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(readAppliedMigrationVersion()).rejects.toThrow(/no applied migration version/i);
  });
});
