import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn() }));

import { exportedThrough, measureExportLag } from "./export-lag";
import { supabaseAdmin } from "@/lib/supabase/admin";

afterEach(() => vi.clearAllMocks());

interface TableFixture {
  /** The export_cursor row for this table (null = nothing exported yet). */
  cursor?: { last_ts: string | null } | null;
  /** The newest un-skipped watermark row (null = no rows). */
  newest?: Record<string, unknown> | null;
  /** Rows past the cursor. */
  backlog?: number | null;
  cursorError?: string;
  countError?: string;
  newestError?: string;
}

/**
 * A fake PostgREST surface that records every filter applied, so a test can
 * assert the skip-redacted predicate really reached the query rather than
 * trusting that it was passed somewhere.
 */
function fakeDb(fixtures: Record<string, TableFixture>) {
  const filters: { table: string; op: string; col: string; val: unknown }[] = [];

  function builder(table: string) {
    const f = fixtures[table] ?? {};
    let isCount = false;
    const b: Record<string, unknown> = {};
    const chain = (op: string) => (col: string, val: unknown) => {
      filters.push({ table, op, col, val });
      return b;
    };
    Object.assign(b, {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) isCount = true;
        return b;
      },
      is: chain("is"),
      eq: chain("eq"),
      gt: chain("gt"),
      order: () => b,
      limit: () => b,
      maybeSingle: async () =>
        table === "export_cursor"
          ? { data: f.cursor ?? null, error: f.cursorError ? { message: f.cursorError } : null }
          : { data: f.newest ?? null, error: f.newestError ? { message: f.newestError } : null },
      then: (resolve: (r: unknown) => unknown) =>
        resolve(
          isCount
            ? { count: f.backlog ?? null, data: null, error: f.countError ? { message: f.countError } : null }
            : { data: null, count: null, error: null },
        ),
    });
    return b;
  }

  vi.mocked(supabaseAdmin).mockReturnValue({ from: (t: string) => builder(t) } as never);
  return { filters };
}

/** Every mirrored table healthy, so a test can perturb exactly one thing. */
function allHealthy(over: Record<string, TableFixture> = {}): Record<string, TableFixture> {
  const base: Record<string, TableFixture> = { export_cursor: { cursor: { last_ts: "2026-07-31T12:00:00Z" } } };
  for (const t of ["bookings", "webhook_deliveries", "booking_outbox", "booking_events", "audit_log", "routing_decisions"]) {
    base[t] = { newest: { updated_at: "2026-07-31T12:05:00Z", created_at: "2026-07-31T12:05:00Z" }, backlog: 2 };
  }
  return { ...base, ...over };
}

describe("measureExportLag", () => {
  it("measures how far each table's newest row is past the export cursor", async () => {
    fakeDb(allHealthy());
    const rows = await measureExportLag();
    expect(rows).toHaveLength(6);
    const bookings = rows.find((r) => r.table === "bookings")!;
    expect(bookings.lagMs).toBe(5 * 60_000);
    expect(bookings.backlog).toBe(2);
  });

  it("reports no lag when the newest row predates the cursor (nothing is waiting)", async () => {
    fakeDb(allHealthy({ bookings: { newest: { updated_at: "2026-07-31T11:00:00Z" }, backlog: 0 } }));
    const bookings = (await measureExportLag()).find((r) => r.table === "bookings")!;
    expect(bookings.lagMs).toBe(0);
  });

  it("excludes redacted rows, which can never be exported and would freeze the gate forever", async () => {
    // #1118: a redacted booking is deliberately skipped by the export lane, so
    // its bumped updated_at must not count as lag. Without this the cursor can
    // never reach it, the gate is permanently not-ready, and ALL retention
    // stops silently.
    const { filters } = fakeDb(allHealthy());
    await measureExportLag();
    const bookingFilters = filters.filter((f) => f.table === "bookings");
    expect(bookingFilters).toContainEqual({ table: "bookings", op: "is", col: "pii_redacted_at", val: null });
    const webhookFilters = filters.filter((f) => f.table === "webhook_deliveries");
    expect(webhookFilters).toContainEqual({
      table: "webhook_deliveries",
      op: "eq",
      col: "payload_erased",
      val: false,
    });
  });

  it("counts the backlog strictly past the cursor position", async () => {
    const { filters } = fakeDb(allHealthy());
    await measureExportLag();
    expect(filters).toContainEqual({
      table: "bookings",
      op: "gt",
      col: "updated_at",
      val: "2026-07-31T12:00:00Z",
    });
  });

  it("reports an infinite lag when rows exist but nothing has ever been exported", async () => {
    fakeDb(allHealthy({ export_cursor: { cursor: null } }));
    const bookings = (await measureExportLag()).find((r) => r.table === "bookings")!;
    expect(bookings.cursorTs).toBeNull();
    expect(bookings.lagMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("reports no lag for an empty table with no cursor (nothing can be behind)", async () => {
    fakeDb(allHealthy({ export_cursor: { cursor: null }, bookings: { newest: null, backlog: 0 } }));
    const bookings = (await measureExportLag()).find((r) => r.table === "bookings")!;
    expect(bookings.lagMs).toBe(0);
  });

  it("reports an unreadable lag rather than a healthy zero when a timestamp cannot be parsed", async () => {
    // A raw Date.parse would yield NaN here and compare false against every
    // threshold, landing on "not lagging" and permitting a delete (#1169/#1171).
    fakeDb(allHealthy({ bookings: { newest: { updated_at: "not a date" }, backlog: 1 } }));
    const bookings = (await measureExportLag()).find((r) => r.table === "bookings")!;
    expect(Number.isNaN(bookings.lagMs)).toBe(true);
  });

  it("throws when the backlog count errors, never reporting a healthy zero backlog", async () => {
    fakeDb(allHealthy({ bookings: { newest: { updated_at: "2026-07-31T12:05:00Z" }, countError: "boom" } }));
    await expect(measureExportLag()).rejects.toThrow(/boom/);
  });

  it("throws when the newest-row read errors, never reporting a healthy zero lag", async () => {
    fakeDb(allHealthy({ bookings: { newestError: "read failed", backlog: 0 } }));
    await expect(measureExportLag()).rejects.toThrow(/read failed/);
  });

  it("throws when the cursor read errors", async () => {
    fakeDb(allHealthy({ export_cursor: { cursorError: "cursor down" } }));
    await expect(measureExportLag()).rejects.toThrow(/cursor down/);
  });
});

describe("exportedThrough", () => {
  it("returns the confirmed-export watermark when present", async () => {
    fakeDb({ export_cursor: { cursor: { last_ts: "2026-01-01T00:00:00Z" } } });
    expect(await exportedThrough("routing_decisions")).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when nothing has been exported yet", async () => {
    fakeDb({ export_cursor: { cursor: null } });
    expect(await exportedThrough("routing_decisions")).toBeNull();
  });

  it("throws on a read error (fail-loud, never silently 'nothing to gate on')", async () => {
    fakeDb({ export_cursor: { cursorError: "boom" } });
    await expect(exportedThrough("routing_decisions")).rejects.toThrow(/boom/);
  });
});
