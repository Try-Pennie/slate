import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./export-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-core")>();
  return { ...actual, exportTable: vi.fn() };
});

import { runSnowflakeExport, makeExportDeps } from "./export";
import { readSnowflakeConfig } from "./config";
import { exportTable, MIRROR_TABLES, type TableSpec } from "./export-core";
import { log } from "@/lib/log";

const cfg = {
  account: "vrkfjso-rwc54963",
  user: "SLATE_SERVICE",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

const okResult = (table: string) => ({ table, key: table, exported: 1, batches: 1, hitDeadline: false });

afterEach(() => vi.clearAllMocks());

describe("runSnowflakeExport", () => {
  it("no-ops when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const res = await runSnowflakeExport();
    expect(res).toEqual({ skipped: "not-configured" });
    expect(exportTable).not.toHaveBeenCalled();
  });

  it("exports every mirrored table and sums the rows when all succeed", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(exportTable).mockImplementation(async (spec) => okResult(spec.table));
    const res = await runSnowflakeExport();
    expect("exported" in res && res.exported).toBe(MIRROR_TABLES.length);
    expect(exportTable).toHaveBeenCalledTimes(MIRROR_TABLES.length);
  });

  it("fails loud when a table errors, but still attempts the others first", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    // First table throws; the rest resolve. The lane must attempt all of them
    // and then throw, rather than stopping at the first failure or reporting ok.
    vi.mocked(exportTable).mockImplementation(async (spec) => {
      if (spec.table === MIRROR_TABLES[0].table) throw new Error("non-terminal Snowflake response");
      return okResult(spec.table);
    });
    await expect(runSnowflakeExport()).rejects.toThrow(/table failure/);
    expect(exportTable).toHaveBeenCalledTimes(MIRROR_TABLES.length);
    expect(log.error).toHaveBeenCalled();
  });
});

// A chainable fake PostgREST builder that records every method call so a test can
// assert what filters the fetch applied (and in what shape).
interface MethodCall {
  m: string;
  args: unknown[];
}
function fakeDb() {
  const byTable: Record<string, MethodCall[]> = {};
  return {
    byTable,
    from(table: string) {
      const methods: MethodCall[] = (byTable[table] = []);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "or", "is", "eq"]) {
        b[m] = (...args: unknown[]) => {
          methods.push({ m, args });
          return b;
        };
      }
      // Thenable: `await q` resolves to an empty, non-error page.
      b.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: [], error: null });
      return b;
    },
  };
}

const specFor = (table: string): TableSpec => MIRROR_TABLES.find((t) => t.table === table)!;
const hasCall = (calls: MethodCall[], m: string, ...args: unknown[]) =>
  calls.some((c) => c.m === m && args.every((a, i) => c.args[i] === a));

describe("makeExportDeps.fetchBatch skip filter (#1118)", () => {
  it("keeps the keyset cursor AND-ed with the bookings skip filter (separate calls, not folded into .or)", async () => {
    const db = fakeDb();
    const deps = makeExportDeps(cfg, db as never);
    await deps.fetchBatch(specFor("bookings"), { last_ts: "2026-01-01T00:00:00Z", last_id: "id1" }, 500);
    const calls = db.byTable["bookings"];
    // The keyset page is still applied as its own .or(...) ...
    expect(hasCall(calls, "or")).toBe(true);
    // ... and the redaction skip is a SEPARATE chained filter, so the fetch reads
    // `(keyset) AND pii_redacted_at IS NULL`, not `keyset OR pii_redacted_at.is.null`.
    expect(hasCall(calls, "is", "pii_redacted_at", null)).toBe(true);
    // The skip filter must never be an .or argument (that would ignore the cursor).
    const orCall = calls.find((c) => c.m === "or");
    expect(String(orCall?.args[0] ?? "")).not.toMatch(/pii_redacted_at/);
  });

  it("applies the bookings skip filter even with no cursor (first tick)", async () => {
    const db = fakeDb();
    const deps = makeExportDeps(cfg, db as never);
    await deps.fetchBatch(specFor("bookings"), null, 500);
    const calls = db.byTable["bookings"];
    expect(hasCall(calls, "or")).toBe(false); // no cursor yet
    expect(hasCall(calls, "is", "pii_redacted_at", null)).toBe(true);
  });

  it("excludes blanked webhook payloads via payload_erased = false", async () => {
    const db = fakeDb();
    const deps = makeExportDeps(cfg, db as never);
    await deps.fetchBatch(specFor("webhook_deliveries"), null, 500);
    expect(hasCall(db.byTable["webhook_deliveries"], "eq", "payload_erased", false)).toBe(true);
  });

  it("applies no skip filter to an append-only table (audit_log)", async () => {
    const db = fakeDb();
    const deps = makeExportDeps(cfg, db as never);
    await deps.fetchBatch(specFor("audit_log"), null, 500);
    const calls = db.byTable["audit_log"];
    expect(hasCall(calls, "is")).toBe(false);
    expect(hasCall(calls, "eq")).toBe(false);
  });
});
