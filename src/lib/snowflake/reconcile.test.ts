import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(async () => ({ data: [["5"]] })),
  escapeSqlLiteral: (s: string) => s,
}));
vi.mock("./export-lag", () => ({ measureExportLag: vi.fn(async () => [] as unknown[]) }));

import { evaluateRecon, reconThreshold, reconcileSnowflakeMirror, type TableRecon } from "./reconcile";
import { readSnowflakeConfig } from "./config";
import { measureExportLag } from "./export-lag";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { TableLag } from "./export-lag-core";

const t = (table: string, supabase: number, snowflake: number): TableRecon => ({
  table,
  supabase,
  snowflake,
  drift: supabase - snowflake,
  // Unmeasured by default, so these cases exercise the total-count path; the
  // exact behind-the-watermark reading (#1231) is set explicitly where it is
  // under test.
  behindCursor: null,
});

afterEach(() => vi.clearAllMocks());

describe("evaluateRecon", () => {
  it("is ok when every table is within the lag tolerance", () => {
    const r = evaluateRecon([t("bookings", 1000, 990), t("audit_log", 3, 3)], [
      { table: "bookings", id: "b1", foundInSnowflake: true },
    ]);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags a table whose drift exceeds the threshold", () => {
    const r = evaluateRecon([t("bookings", 1000, 800)], []);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/bookings: Snowflake is behind by 200/);
  });

  it("does NOT flag Snowflake ahead (expected once retention prunes Supabase, #1102)", () => {
    const r = evaluateRecon([t("bookings", 100, 130)], []);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails when the positive control did not find its known row (a zero cannot be trusted)", () => {
    const r = evaluateRecon([t("bookings", 5, 5)], [{ table: "bookings", id: "oldest", foundInSnowflake: false }]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/positive control failed/);
  });

  it("fails when ANY control fails, and names which table it was (#1139)", () => {
    // routing_decisions is the table retention actually HARD-DELETES from, and
    // it had no control at all: a broken count query there read as zero drift.
    const r = evaluateRecon([t("routing_decisions", 5, 5)], [
      { table: "bookings", id: "b1", foundInSnowflake: true },
      { table: "routing_decisions", id: "r1", foundInSnowflake: false },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/routing_decisions row r1/);
    expect(r.reasons.join(" ")).not.toMatch(/bookings row b1/);
  });

  it("threshold is the larger of the flat floor and a small percentage", () => {
    expect(reconThreshold(100)).toBe(25); // floor wins on small tables
    expect(reconThreshold(10_000)).toBe(200); // 2% wins at scale
  });
});

/**
 * #1230: the drift reason must name the cause it MEASURED.
 *
 * On 2026-08-03 the lane paged `audit_log: Snowflake is behind by 251 rows
 * (27/278)` under copy that said "the export lane may be lagging or failing".
 * The lane was fully caught up: those 251 rows were the OOO audit backfill,
 * inserted behind the forward `created_at` watermark, which the keyset fetch can
 * never revisit. The alert named the one cause that was not happening (L11).
 */
describe("evaluateRecon drift cause (#1230)", () => {
  const lag = (table: string, over: Partial<TableLag> = {}): TableLag => ({
    table,
    cursorTs: "2026-08-03T12:00:00.000Z",
    newestTs: "2026-08-03T12:00:00.000Z",
    lagMs: 0,
    backlog: 0,
    ...over,
  });

  it("says the rows sit behind the watermark when the export lane is measured current", () => {
    // The real 2026-08-03 shape: cursor on the newest row, nothing waiting.
    const r = evaluateRecon([t("audit_log", 278, 27)], [], [lag("audit_log")]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/audit_log: Snowflake is behind by 251 rows \(27\/278\)/);
    expect(r.reasons[0]).toMatch(/export lane is current/);
    expect(r.reasons[0]).toMatch(/251 of these rows sit behind/);
    expect(r.reasons[0]).toMatch(/will never export on their own/);
    // The remedy travels with the cause that needs it, not in the wrapper.
    expect(r.reasons[0]).toMatch(/reexport\.ts/);
    // Must NOT accuse the lane of being behind, which is what shipped.
    expect(r.reasons[0]).not.toMatch(/lane is \d+ (minute|hour)/);
  });

  it("says how far behind the lane is when the lane really is the cause", () => {
    const r = evaluateRecon(
      [t("bookings", 10412, 9880)],
      [],
      [lag("bookings", { lagMs: 3 * 60 * 60_000, backlog: 540 })],
    );
    expect(r.reasons[0]).toMatch(/export lane is 3 hours behind/);
    expect(r.reasons[0]).toMatch(/540 rows waiting/);
    expect(r.reasons[0]).toMatch(/clears itself once the lane catches up/);
    expect(r.reasons[0]).not.toMatch(/never export/);
    expect(r.reasons[0]).not.toMatch(/reexport\.ts/);
  });

  it("says the cause is unknown when the lane's position was not measured", () => {
    // An unmeasured signal must not be presented as either cause.
    const r = evaluateRecon([t("bookings", 10412, 9880)], [], []);
    expect(r.reasons[0]).toMatch(/could not be read/);
    expect(r.reasons[0]).not.toMatch(/never export/);
    expect(r.reasons[0]).not.toMatch(/hours behind/);
  });

  it("treats an unreadable timestamp as unknown, not as a current lane (#1171)", () => {
    const r = evaluateRecon([t("bookings", 10412, 9880)], [], [lag("bookings", { lagMs: Number.NaN })]);
    expect(r.reasons[0]).toMatch(/could not be read/);
    expect(r.reasons[0]).not.toMatch(/NaN/);
    expect(r.reasons[0]).not.toMatch(/is current/);
  });

  it("says the lane has not started when nothing was ever exported", () => {
    const r = evaluateRecon(
      [t("audit_log", 278, 0)],
      [],
      [lag("audit_log", { cursorTs: null, lagMs: Number.POSITIVE_INFINITY, backlog: 278 })],
    );
    expect(r.reasons[0]).toMatch(/nothing has ever been exported/);
    expect(r.reasons[0]).not.toMatch(/Infinity/);
  });

  /**
   * #1231: the EXACT reading. Every row strictly behind the cursor should already
   * be in the warehouse, and every legitimate difference (rows at the cursor, rows
   * retention later deleted from Supabase, redacted rows the warehouse still
   * holds) makes the warehouse BIGGER. So `behindCursor > snowflake` needs no
   * tolerance and catches a single stranded row, where the total-count drift needs
   * 25 rows or 2% before it can speak.
   */
  it("flags rows behind the watermark that the warehouse lacks, even under the drift tolerance", () => {
    const r = evaluateRecon(
      [{ table: "audit_log", supabase: 300, snowflake: 295, drift: 5, behindCursor: 299 }],
      [],
      [lag("audit_log")],
    );
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/at least 4 rows/);
    expect(r.reasons[0]).toMatch(/behind the export watermark/);
    expect(r.reasons[0]).toMatch(/reexport\.ts/);
  });

  it("catches a single stranded row", () => {
    const r = evaluateRecon(
      [{ table: "booking_events", supabase: 1086, snowflake: 1084, drift: 2, behindCursor: 1085 }],
      [],
      [lag("booking_events")],
    );
    expect(r.reasons[0]).toMatch(/at least 1 row that sits behind the export watermark is missing/);
  });

  it("reads as plain English in the plural too", () => {
    const r = evaluateRecon(
      [{ table: "audit_log", supabase: 300, snowflake: 295, drift: 5, behindCursor: 299 }],
      [],
      [lag("audit_log")],
    );
    expect(r.reasons[0]).toMatch(/at least 4 rows that sit behind the export watermark are missing/);
  });

  it("is quiet when the warehouse holds MORE than the rows behind the cursor", () => {
    // The normal state once retention prunes Supabase and redaction skips rows.
    const r = evaluateRecon(
      [{ table: "routing_decisions", supabase: 100, snowflake: 400, drift: -300, behindCursor: 99 }],
      [],
      [lag("routing_decisions")],
    );
    expect(r.ok).toBe(true);
  });

  it("says nothing about stranding when nothing has been exported yet", () => {
    // No cursor means no rows are behind it; the lag path is what speaks here.
    const r = evaluateRecon(
      [{ table: "audit_log", supabase: 278, snowflake: 0, drift: 278, behindCursor: null }],
      [],
      [lag("audit_log", { cursorTs: null, lagMs: Number.POSITIVE_INFINITY, backlog: 278 })],
    );
    expect(r.reasons[0]).toMatch(/nothing has ever been exported/);
    expect(r.reasons.filter((x) => /behind the export watermark/.test(x))).toHaveLength(0);
  });

  it("reports one missing-rows reason per table, not two", () => {
    // The exact reading and the tolerance drift would both fire here; the exact
    // one is authoritative, so the reader gets a count and not an estimate twice.
    const r = evaluateRecon(
      [{ table: "audit_log", supabase: 278, snowflake: 27, drift: 251, behindCursor: 277 }],
      [],
      [lag("audit_log")],
    );
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/at least 250 rows/);
  });

  it("does not attach a cause to a positive-control failure (it is not about lag)", () => {
    const r = evaluateRecon([t("bookings", 5, 5)], [{ table: "bookings", id: "oldest", foundInSnowflake: false }], []);
    expect(r.reasons[0]).toMatch(/positive control failed/);
    expect(r.reasons[0]).not.toMatch(/export lane/);
  });
});

describe("reconcileSnowflakeMirror", () => {
  it("skips (and reports ok) when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await reconcileSnowflakeMirror();
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.tables).toEqual([]);
  });

  it("counts Supabase with the SAME skip predicate the export uses (#1118, Flaw B)", async () => {
    // Reconcile must exclude redacted rows from the Supabase count. Otherwise a
    // row erased before its first export (present in Supabase, never in Snowflake)
    // reads as permanent "Snowflake is behind" drift, which freezes retention.
    vi.mocked(readSnowflakeConfig).mockReturnValue({
      account: "a",
      user: "u",
      privateKeyPem: "k",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "W",
      role: "R",
    });

    const invocations: { table: string; methods: { m: string; args: unknown[] }[] }[] = [];
    const db = {
      from(table: string) {
        const methods: { m: string; args: unknown[] }[] = [];
        invocations.push({ table, methods });
        const b: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit", "is", "eq"]) {
          b[m] = (...args: unknown[]) => {
            methods.push({ m, args });
            return b;
          };
        }
        b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
        b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
          resolve({ count: 5, data: [], error: null });
        return b;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);

    await reconcileSnowflakeMirror();

    // The bookings COUNT read (select "*") excludes redacted rows.
    const bookingsCount = invocations.find((v) => v.table === "bookings" && v.methods[0]?.args[0] === "*");
    expect(bookingsCount?.methods.some((m) => m.m === "is" && m.args[0] === "pii_redacted_at" && m.args[1] === null)).toBe(
      true,
    );
    // The webhook COUNT read excludes blanked payloads.
    const whCount = invocations.find((v) => v.table === "webhook_deliveries");
    expect(whCount?.methods.some((m) => m.m === "eq" && m.args[0] === "payload_erased" && m.args[1] === false)).toBe(true);
    // An append-only table is counted whole (no skip filter).
    const auditCount = invocations.find((v) => v.table === "audit_log");
    expect(auditCount?.methods.some((m) => m.m === "is" || m.m === "eq")).toBe(false);
  });

  it("runs a positive control on routing_decisions as well as bookings (#1139)", async () => {
    // routing_decisions is the one table retention hard-deletes from, and it was
    // the one with no control: nothing proved a zero count there was real.
    vi.mocked(readSnowflakeConfig).mockReturnValue({
      account: "a",
      user: "u",
      privateKeyPem: "k",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "W",
      role: "R",
    });
    const db = {
      from() {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit", "is", "eq"]) b[m] = () => b;
        b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
        b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
          resolve({ count: 5, data: [], error: null });
        return b;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);

    const r = await reconcileSnowflakeMirror();

    expect(r.controls.map((c) => c.table).sort()).toEqual(["bookings", "routing_decisions"]);
  });

  // --- #1230: the lane's own position feeds the reason -------------------------
  const configured = () =>
    vi.mocked(readSnowflakeConfig).mockReturnValue({
      account: "a",
      user: "u",
      privateKeyPem: "k",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "W",
      role: "R",
    });

  /** A Supabase stand-in whose every count read answers `count`. */
  const dbWithCount = (count: number) => ({
    from() {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "is", "eq", "lt"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
      b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
        resolve({ count, data: [], error: null });
      return b;
    },
  });

  it("feeds the measured export lag into the reason (#1230/#1231)", async () => {
    configured();
    vi.mocked(supabaseAdmin).mockReturnValue(dbWithCount(300) as never);
    // Every mirrored table's lane is current, so a drift can only be rows sitting
    // behind the watermark.
    vi.mocked(measureExportLag).mockResolvedValue([
      { table: "audit_log", cursorTs: "2026-08-03T12:00:00.000Z", newestTs: "2026-08-03T12:00:00.000Z", lagMs: 0, backlog: 0 },
    ] as never);

    const r = await reconcileSnowflakeMirror();

    // The cursor position only reaches this reason via the lag reading: without it
    // the table's behindCursor is unmeasured and the copy falls back to the
    // unknown-cause wording (proved by the failure-path test below).
    const auditReason = r.reasons.find((x) => x.startsWith("audit_log:"));
    expect(auditReason).toMatch(/at least 295 rows that sit behind the export watermark are missing/);
    expect(auditReason).toMatch(/will never export on their own/);
  });

  it("counts the rows behind the cursor with the skip predicate and the table's own watermark (#1231)", async () => {
    configured();
    const invocations: { table: string; methods: { m: string; args: unknown[] }[] }[] = [];
    const db = {
      from(table: string) {
        const methods: { m: string; args: unknown[] }[] = [];
        invocations.push({ table, methods });
        const b: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit", "is", "eq", "lt"]) {
          b[m] = (...args: unknown[]) => {
            methods.push({ m, args });
            return b;
          };
        }
        b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
        b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
          resolve({ count: 300, data: [], error: null });
        return b;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);
    vi.mocked(measureExportLag).mockResolvedValue([
      { table: "bookings", cursorTs: "2026-08-03T12:00:00.000Z", newestTs: "2026-08-03T12:00:00.000Z", lagMs: 0, backlog: 0 },
      { table: "audit_log", cursorTs: "2026-08-03T12:00:00.000Z", newestTs: "2026-08-03T12:00:00.000Z", lagMs: 0, backlog: 0 },
    ] as never);

    const r = await reconcileSnowflakeMirror();

    // bookings is watermarked on updated_at and skips redacted rows; the
    // behind-cursor read must carry BOTH, or it counts a different set than the
    // export sent and the comparison is meaningless.
    const behind = invocations.find(
      (v) => v.table === "bookings" && v.methods.some((m) => m.m === "lt" && m.args[0] === "updated_at"),
    );
    expect(behind).toBeDefined();
    expect(behind?.methods.some((m) => m.m === "lt" && m.args[1] === "2026-08-03T12:00:00.000Z")).toBe(true);
    expect(behind?.methods.some((m) => m.m === "is" && m.args[0] === "pii_redacted_at")).toBe(true);
    // audit_log is watermarked on created_at, not updated_at.
    const auditBehind = invocations.find(
      (v) => v.table === "audit_log" && v.methods.some((m) => m.m === "lt" && m.args[0] === "created_at"),
    );
    expect(auditBehind).toBeDefined();
    expect(r.tables.find((x) => x.table === "audit_log")?.behindCursor).toBe(300);
  });

  it("leaves behindCursor unmeasured when the table has no cursor yet", async () => {
    configured();
    vi.mocked(supabaseAdmin).mockReturnValue(dbWithCount(300) as never);
    vi.mocked(measureExportLag).mockResolvedValue([
      { table: "audit_log", cursorTs: null, newestTs: "2026-08-03T12:00:00.000Z", lagMs: Infinity, backlog: 300 },
    ] as never);

    const r = await reconcileSnowflakeMirror();

    expect(r.tables.find((x) => x.table === "audit_log")?.behindCursor).toBeNull();
  });

  it("throws rather than reporting zero when the behind-cursor count errors", async () => {
    // A failed count that read as 0 would mean "nothing is behind the cursor",
    // which is indistinguishable from a healthy mirror (#1165). Fail loud: the
    // route 500s, the heartbeat is not stamped, and the lane watchdog pages.
    configured();
    const db = {
      from() {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit", "is", "eq"]) b[m] = () => b;
        b.lt = () => ({
          then: (resolve: (v: { count: null; data: null; error: { message: string } }) => unknown) =>
            resolve({ count: null, data: null, error: { message: "column updated_at does not exist" } }),
        });
        b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
        b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
          resolve({ count: 300, data: [], error: null });
        return b;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);
    vi.mocked(measureExportLag).mockResolvedValue([
      { table: "bookings", cursorTs: "2026-08-03T12:00:00.000Z", newestTs: "2026-08-03T12:00:00.000Z", lagMs: 0, backlog: 0 },
    ] as never);

    await expect(reconcileSnowflakeMirror()).rejects.toThrow(/does not exist/);
  });

  it("still reports the drift when the lag measurement itself fails, with an honest unknown cause", async () => {
    // Fail-loud, not fail-silent: losing the page because the DIAGNOSIS read
    // broke would hide the drift the lane exists to report.
    configured();
    vi.mocked(supabaseAdmin).mockReturnValue(dbWithCount(300) as never);
    vi.mocked(measureExportLag).mockRejectedValue(new Error("export_cursor unreadable") as never);

    const r = await reconcileSnowflakeMirror();

    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/Snowflake is behind by 295 rows/);
    expect(r.reasons[0]).toMatch(/could not be read/);
    expect(log.warn).toHaveBeenCalled();
  });
});
