import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./reconcile", () => ({ reconcileSnowflakeMirror: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn() }));

import { exportedThrough, mirrorReadyForDeletion } from "./retention-gate";
import { reconcileSnowflakeMirror } from "./reconcile";
import { supabaseAdmin } from "@/lib/supabase/admin";

afterEach(() => vi.clearAllMocks());

describe("mirrorReadyForDeletion", () => {
  it("is not ready when the mirror is unconfigured (never delete unarchived data)", async () => {
    vi.mocked(reconcileSnowflakeMirror).mockResolvedValue({
      skipped: true,
      ok: true,
      tables: [],
      control: null,
      reasons: [],
    });
    const g = await mirrorReadyForDeletion();
    expect(g.ready).toBe(false);
    expect(g.reason).toMatch(/not configured/);
  });

  it("is not ready when reconciliation reports the mirror is behind", async () => {
    vi.mocked(reconcileSnowflakeMirror).mockResolvedValue({
      ok: false,
      tables: [],
      control: null,
      reasons: ["bookings: Snowflake is behind by 999 rows"],
    });
    const g = await mirrorReadyForDeletion();
    expect(g.ready).toBe(false);
    expect(g.reason).toMatch(/behind by 999/);
  });

  it("is ready when configured and in sync", async () => {
    vi.mocked(reconcileSnowflakeMirror).mockResolvedValue({ ok: true, tables: [], control: null, reasons: [] });
    expect((await mirrorReadyForDeletion()).ready).toBe(true);
  });
});

describe("exportedThrough", () => {
  function fakeCursor(row: { last_ts: string | null } | null, error: { message: string } | null = null) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: row, error }),
    };
    vi.mocked(supabaseAdmin).mockReturnValue({ from: () => builder } as never);
  }

  it("returns the confirmed-export watermark when present", async () => {
    fakeCursor({ last_ts: "2026-01-01T00:00:00Z" });
    expect(await exportedThrough("routing_decisions")).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when nothing has been exported yet", async () => {
    fakeCursor(null);
    expect(await exportedThrough("routing_decisions")).toBeNull();
  });

  it("throws on a read error (fail-loud, never silently 'nothing to gate on')", async () => {
    fakeCursor(null, { message: "boom" });
    await expect(exportedThrough("routing_decisions")).rejects.toThrow(/boom/);
  });
});
