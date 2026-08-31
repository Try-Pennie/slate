/**
 * Loading the erasure purge worklist (#1124).
 *
 * The failure paths are the point. Three reads can fail independently (the audit
 * trail, the warehouse config, the residual measurement), and every one of them
 * has an empty shaped answer that would render as a clean, reassuring screen:
 *
 *   - a failed TRAIL read gives no entries, which reads as "nothing has ever been
 *     erased" and is exactly how a missed purge would stay invisible.
 *   - a failed RESIDUAL read gives no counts, which reads as zero residual and
 *     certifies a request honored that nobody measured (the #1197 shape).
 *
 * So each is asserted to come back as its own explicit unknown rather than as an
 * empty list or a zero.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./erasure-trail", () => ({ readErasureAuditRows: vi.fn() }));
vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./erasure-audit", () => ({ residualsForBookingIds: vi.fn() }));

import { loadErasureWorklist } from "./erasure-worklist-load";
import { readErasureAuditRows } from "./erasure-trail";
import { readSnowflakeConfig } from "./config";
import { residualsForBookingIds } from "./erasure-audit";

const ORG = "org-1";
const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "W",
  role: "R",
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "audit-1",
  org_id: ORG,
  created_at: "2026-08-20T09:00:00+00:00",
  details: { booking_ids: ["bk1", "bk2"], email_sha256: "abc" },
  ...over,
});

const clean = [
  { table: "bookings", residual: 0 },
  { table: "booking_events", residual: 0 },
];

beforeEach(() => {
  vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
  vi.mocked(readErasureAuditRows).mockResolvedValue([row()] as never);
  vi.mocked(residualsForBookingIds).mockResolvedValue(clean);
});
afterEach(() => vi.clearAllMocks());

describe("loadErasureWorklist", () => {
  it("lists the org's erasures with a measured residual", async () => {
    const state = await loadErasureWorklist(ORG);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.warehouse).toEqual({ kind: "measured" });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].bookingIds).toEqual(["bk1", "bk2"]);
    expect(state.entries[0].emailSha256).toBe("abc");
    expect(state.entries[0].residuals).not.toBeNull();
    expect(state.entries[0].unmeasuredReason).toBeNull();
  });

  it("reports an unreadable TRAIL as its own state, never as an empty list", async () => {
    vi.mocked(readErasureAuditRows).mockRejectedValue(new Error("permission denied for audit_log"));
    const state = await loadErasureWorklist(ORG);
    expect(state.kind).toBe("trail-unreadable");
    if (state.kind !== "trail-unreadable") return;
    expect(state.reason).toMatch(/permission denied/);
    // The whole point: nothing downstream can read this as "no outstanding purges".
    expect("entries" in state).toBe(false);
  });

  it("reports an unreadable RESIDUAL as unknown, never as a clean zero", async () => {
    vi.mocked(residualsForBookingIds).mockRejectedValue(new Error("Snowflake returned 503"));
    const state = await loadErasureWorklist(ORG);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.warehouse.kind).toBe("unreadable");
    expect(state.entries[0].residuals).toBeNull();
    expect(state.entries[0].unmeasuredReason).toMatch(/503/);
  });

  it("reports an unconfigured mirror separately from an unreadable one", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const state = await loadErasureWorklist(ORG);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.warehouse.kind).toBe("unconfigured");
    expect(state.entries[0].residuals).toBeNull();
    expect(residualsForBookingIds).not.toHaveBeenCalled();
  });

  it("treats a half configured mirror (readSnowflakeConfig throws) as unreadable", async () => {
    vi.mocked(readSnowflakeConfig).mockImplementation(() => {
      throw new Error("SNOWFLAKE_ACCOUNT is missing");
    });
    const state = await loadErasureWorklist(ORG);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.warehouse.kind).toBe("unreadable");
    expect(state.entries[0].residuals).toBeNull();
  });

  it("spends no extra warehouse call when the trail wide residual is zero", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([
      row({ id: "a", details: { booking_ids: ["bk1"] } }),
      row({ id: "b", created_at: "2026-08-21T09:00:00+00:00", details: { booking_ids: ["bk2"] } }),
    ] as never);
    const state = await loadErasureWorklist(ORG);
    expect(residualsForBookingIds).toHaveBeenCalledTimes(1);
    if (state.kind !== "ready") throw new Error("expected ready");
    // A measured zero over the union proves each subset is zero, so each entry is
    // reported clean rather than unknown.
    for (const e of state.entries) expect(e.residuals).not.toBeNull();
  });

  it("attributes a non zero residual to the entry that owns it", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([
      row({ id: "a", details: { booking_ids: ["bk1"] } }),
      row({ id: "b", created_at: "2026-08-21T09:00:00+00:00", details: { booking_ids: ["bk2"] } }),
    ] as never);
    vi.mocked(residualsForBookingIds).mockImplementation(async (_c, ids: string[]) =>
      ids.includes("bk2") && ids.length === 1
        ? [{ table: "bookings", residual: 1 }]
        : ids.length === 1
          ? [{ table: "bookings", residual: 0 }]
          : [{ table: "bookings", residual: 1 }],
    );
    const state = await loadErasureWorklist(ORG);
    if (state.kind !== "ready") throw new Error("expected ready");
    const b = state.entries.find((e) => e.auditId === "b");
    const a = state.entries.find((e) => e.auditId === "a");
    expect(b?.residuals).toEqual([{ table: "bookings", residual: 1 }]);
    expect(a?.residuals).toEqual([{ table: "bookings", residual: 0 }]);
  });

  it("marks just the entry whose attribution read failed, not the whole page", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([
      row({ id: "a", details: { booking_ids: ["bk1"] } }),
      row({ id: "b", created_at: "2026-08-21T09:00:00+00:00", details: { booking_ids: ["bk2"] } }),
    ] as never);
    vi.mocked(residualsForBookingIds).mockImplementation(async (_c, ids: string[]) => {
      if (ids.length > 1) return [{ table: "bookings", residual: 1 }];
      if (ids[0] === "bk2") throw new Error("statement timed out");
      return [{ table: "bookings", residual: 1 }];
    });
    const state = await loadErasureWorklist(ORG);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.entries.find((e) => e.auditId === "b")?.residuals).toBeNull();
    expect(state.entries.find((e) => e.auditId === "b")?.unmeasuredReason).toMatch(/timed out/);
    expect(state.entries.find((e) => e.auditId === "a")?.residuals).not.toBeNull();
  });

  it("shows only the reader's org, and still names what the trail wide purge reaches", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([
      row({ id: "mine", details: { booking_ids: ["bk1", "bk2"] } }),
      row({ id: "theirs", org_id: "org-2", details: { booking_ids: ["bk9"] } }),
    ] as never);
    const state = await loadErasureWorklist(ORG);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.entries.map((e) => e.auditId)).toEqual(["mine"]);
    expect(state.trail).toEqual({ entryCount: 2, bookingCount: 3, otherOrgBookingCount: 1 });
    // The residual is measured over the reader's bookings only.
    expect(vi.mocked(residualsForBookingIds).mock.calls[0][1]).toEqual(["bk1", "bk2"]);
  });

  it("asks the warehouse nothing when the org has no erasures", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([] as never);
    const state = await loadErasureWorklist(ORG);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.entries).toEqual([]);
    expect(state.trail.bookingCount).toBe(0);
    expect(residualsForBookingIds).not.toHaveBeenCalled();
  });

  it("puts the newest erasure first", async () => {
    vi.mocked(readErasureAuditRows).mockResolvedValue([
      row({ id: "older", created_at: "2026-08-01T09:00:00+00:00", details: { booking_ids: ["bk1"] } }),
      row({ id: "newer", created_at: "2026-08-25T09:00:00+00:00", details: { booking_ids: ["bk2"] } }),
    ] as never);
    const state = await loadErasureWorklist(ORG);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.entries.map((e) => e.auditId)).toEqual(["newer", "older"]);
  });
});
