import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
// The audit reads `bookings.is_test` to split the trail (#1196). This fake lets a
// test choose what that read answers, including FAILING, which is the case the
// fallback direction exists for. Default: no rows, so every id is unclassified and
// therefore treated as real, which is what the pre-#1196 assertions below expect.
const bookingClassRead: { rows: { id: string; is_test: boolean }[] | null } = { rows: [] };
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(async () =>
          bookingClassRead.rows === null
            ? { data: null, error: { message: "read failed" } }
            : { data: bookingClassRead.rows, error: null },
        ),
      })),
    })),
  })),
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(async () => ({ data: [["0"]] })),
  escapeSqlLiteral: (s: string) => s,
}));
vi.mock("@/lib/supabase/paginate", () => ({ selectAllPages: vi.fn(async () => []) }));

import { classifyErasedBookings, evaluateErasureAudit, auditSnowflakeErasures } from "./erasure-audit";
import { readSnowflakeConfig } from "./config";
import { selectAllPages } from "@/lib/supabase/paginate";
import { executeStatement } from "./client";

const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "W",
  role: "R",
};

afterEach(() => {
  vi.clearAllMocks();
  bookingClassRead.rows = [];
});

describe("evaluateErasureAudit", () => {
  it("is ok when no erased booking holds residual PII in Snowflake", () => {
    const r = evaluateErasureAudit([
      { table: "bookings", residual: 0 },
      { table: "booking_events", residual: 0 },
      { table: "webhook_deliveries", residual: 0 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags a table that still holds PII for erased bookings", () => {
    const r = evaluateErasureAudit([{ table: "bookings", residual: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/bookings.*2/);
  });

  it("flags every table with residual PII", () => {
    const r = evaluateErasureAudit([
      { table: "bookings", residual: 1 },
      { table: "webhook_deliveries", residual: 3 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

describe("auditSnowflakeErasures", () => {
  it("skips (and reports ok) when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await auditSnowflakeErasures();
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("does no Snowflake read when there are no erasure audit rows", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([]);
    const r = await auditSnowflakeErasures();
    expect(r.ok).toBe(true);
    expect(r.erasedBookings).toBe(0);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("flags residual PII when an erased booking still has contact data in Snowflake", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1", "bk2"] } }]);
    // bookings still holds one row with an email; the other tables are clean.
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) => ({ data: [[sql.includes("FROM bookings") ? "1" : "0"]] }) as never,
    );
    const r = await auditSnowflakeErasures();
    expect(r.erasedBookings).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/bookings/);
  });

  // #1205: `last_response` holds up to 1000 chars of the subscriber's response
  // body, which commonly quotes the request and so carries attendee name, email
  // and phone. Supabase blanks it on erasure, but blanking sets `payload_erased`,
  // which FREEZES the row from re-export, so the Supabase null never reaches the
  // warehouse. This audit is the only unattended thing that can catch it.
  it("flags a webhook delivery whose last_response still holds the response body", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    // The payload was purged correctly, so the OLD check finds nothing. Only a
    // query that looks at last_response can see this residual, which is exactly
    // how the gap read as "clean" while contact data sat in the warehouse.
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) =>
        ({ data: [[/last_response/i.test(sql) ? "1" : "0"]] }) as never,
    );

    const r = await auditSnowflakeErasures();

    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/webhook_deliveries/);
  });

  // The outbox PAYLOAD is out of erasure scope (staff free text, internal ids), but
  // last_error is `err.message` from whatever a step threw, and two steps are
  // outbound calls, so a Google Calendar error can quote an attendee email.
  it("flags an outbox row whose last_error still holds an external error message", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) =>
        ({ data: [[/booking_outbox/i.test(sql) ? "1" : "0"]] }) as never,
    );

    const r = await auditSnowflakeErasures();

    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/booking_outbox/);
  });

  it("does not judge the outbox payload, only its error text", async () => {
    // Guards the scope split: counting reasonDetail would flag staff free text that
    // is deliberately not erased, so the audit would alert on healthy rows forever.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    vi.mocked(executeStatement).mockResolvedValue({ data: [["0"]] } as never);

    await auditSnowflakeErasures();

    const outboxQuery = vi
      .mocked(executeStatement)
      .mock.calls.map((c) => String(c[1]))
      .find((s) => /FROM booking_outbox/i.test(s));
    expect(outboxQuery).toBeDefined();
    expect(outboxQuery).toMatch(/last_error\s+IS\s+NOT\s+NULL/i);
    expect(outboxQuery).not.toMatch(/reasonDetail/i);
  });

  it("asks Snowflake about last_response at all", async () => {
    // Pins the query shape rather than only the verdict: without this, the test
    // above could pass on a query that merely happens to mention the column in a
    // comment, and a refactor that dropped the condition would stay green.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    vi.mocked(executeStatement).mockResolvedValue({ data: [["0"]] } as never);

    await auditSnowflakeErasures();

    const asked = vi.mocked(executeStatement).mock.calls.map((c) => String(c[1]));
    const webhookQuery = asked.find((s) => /FROM webhook_deliveries/i.test(s));
    expect(webhookQuery).toBeDefined();
    expect(webhookQuery).toMatch(/last_response\s+IS\s+NOT\s+NULL/i);
  });
});

/**
 * Test versus real classification (#1196).
 *
 * A residual on a synthetic SMOKE booking and a residual on a real person's
 * booking need different responses: one is an operational tidy-up with zero
 * exposure, the other is an incomplete data-subject erasure with a clock on it.
 * The audit partitions the trail so the lane can page for one and whisper for the
 * other.
 *
 * The direction of the fallback is the whole safety argument: an id whose class
 * cannot be READ counts as REAL. Landing an unreadable classification on "test"
 * would silently downgrade a genuine compliance page, which is the L42 shape (a
 * protective control failing open).
 */
describe("classifyErasedBookings", () => {
  it("splits the trail into real and test by is_test", () => {
    const r = classifyErasedBookings(["a", "b", "c"], [
      { id: "a", is_test: false },
      { id: "b", is_test: true },
      { id: "c", is_test: false },
    ]);
    expect(r.realIds).toEqual(["a", "c"]);
    expect(r.testIds).toEqual(["b"]);
    expect(r.unreadable).toBeNull();
  });

  it("counts an id the bookings read never returned as REAL, not test", () => {
    const r = classifyErasedBookings(["a", "missing"], [{ id: "a", is_test: true }]);
    expect(r.testIds).toEqual(["a"]);
    expect(r.realIds).toEqual(["missing"]);
    expect(r.unreadable).toMatch(/missing/);
  });

  it("counts EVERY id as real when the class could not be read at all", () => {
    const r = classifyErasedBookings(["a", "b"], null);
    expect(r.realIds).toEqual(["a", "b"]);
    expect(r.testIds).toEqual([]);
    expect(r.unreadable).toBeTruthy();
  });

  it("reports nothing unreadable when every id was classified", () => {
    const r = classifyErasedBookings(["a"], [{ id: "a", is_test: true }]);
    expect(r.unreadable).toBeNull();
  });
});

/**
 * The split reaching the outcome the LANE branches on (#1196).
 *
 * The pure classifier above proves the partition; these prove the audit actually
 * routes each class to its own field, because a correct partition wired into one
 * field would page for test data exactly as before while every unit test passed.
 */
describe("auditSnowflakeErasures test/real split", () => {
  const trail = (ids: string[]) =>
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ids } }] as never);

  /** Snowflake reports a residual only for the ids this statement mentions. */
  const residualFor = (dirty: string[]) =>
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) =>
        ({ data: [[dirty.some((id) => sql.includes(id)) && sql.includes("FROM bookings") ? "1" : "0"]] }) as never,
    );

  it("does not page for a residual that belongs only to a test booking", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    trail(["bk-smoke"]);
    bookingClassRead.rows = [{ id: "bk-smoke", is_test: true }];
    residualFor(["bk-smoke"]);

    const r = await auditSnowflakeErasures();
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.testReasons.join(" ")).toMatch(/bookings/);
    expect(r.testBookingIds).toEqual(["bk-smoke"]);
    expect(r.realBookingIds).toEqual([]);
  });

  it("pages for a real booking's residual and keeps the two sides separate", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    trail(["bk-real", "bk-smoke"]);
    bookingClassRead.rows = [
      { id: "bk-real", is_test: false },
      { id: "bk-smoke", is_test: true },
    ];
    residualFor(["bk-real"]);

    const r = await auditSnowflakeErasures();
    expect(r.ok).toBe(false);
    expect(r.realBookingIds).toEqual(["bk-real"]);
    expect(r.testReasons).toEqual([]);
    expect(r.classificationUnreadable).toBeNull();
  });

  /**
   * The one that matters. A class read that FAILS must not turn a real residual
   * into a whisper, so the fallback treats every booking as real even when it is
   * genuinely a test fixture. The cost is a real page about fake data, which is
   * the direction we want to be wrong in (L42).
   */
  it("pages for a TEST booking's residual when the class could not be read at all", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    trail(["bk-smoke"]);
    bookingClassRead.rows = null;
    residualFor(["bk-smoke"]);

    const r = await auditSnowflakeErasures();
    expect(r.ok).toBe(false);
    expect(r.realBookingIds).toEqual(["bk-smoke"]);
    expect(r.testReasons).toEqual([]);
    expect(r.classificationUnreadable).toBeTruthy();
  });

  it("asks Snowflake nothing about a side with no bookings in it", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    trail(["bk-real"]);
    bookingClassRead.rows = [{ id: "bk-real", is_test: false }];
    residualFor([]);

    await auditSnowflakeErasures();
    const asked = vi.mocked(executeStatement).mock.calls.map((c) => c[1] as string);
    expect(asked.length).toBeGreaterThan(0);
    // Every statement names the real booking; none was sent for an empty test side.
    expect(asked.every((sql) => sql.includes("bk-real"))).toBe(true);
  });
});
