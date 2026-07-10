import { describe, it, expect, vi, beforeEach } from "vitest";

// #512: the rotating-scan cursor persistence and the read -> run -> advance wiring
// for the self-heal sweeps. The pure offset math lives in scan-rotation.ts (node
// tested); here we mock the db to pin the plumbing and the failure handling.

const maybeSingle = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() =>
  vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null })),
);
const eq = vi.hoisted(() => vi.fn(() => ({ maybeSingle })));
const select = vi.hoisted(() => vi.fn(() => ({ eq })));
const from = vi.hoisted(() => vi.fn(() => ({ select, upsert })));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { loadScanOffset, saveScanOffset, rotateSelfhealScan } from "./selfheal-cursor";

const LIMIT = 200;
beforeEach(() => vi.clearAllMocks());

describe("loadScanOffset", () => {
  it("returns the stored offset", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { next_offset: 400 }, error: null });
    expect(await loadScanOffset("k")).toBe(400);
  });

  it("defaults to 0 when there is no cursor row yet", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await loadScanOffset("k")).toBe(0);
  });

  // Best-effort: a lost cursor read must not break the sweep. Restarting from 0
  // is safe (the sweep re-scans the priority page), so degrade to 0, not throw.
  it("degrades to 0 when the read errors", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await loadScanOffset("k")).toBe(0);
  });
});

describe("saveScanOffset", () => {
  it("upserts the offset for the key", async () => {
    await saveScanOffset("k", 200);
    expect(from).toHaveBeenCalledWith("selfheal_scan_cursor");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k", next_offset: 200 }),
    );
  });

  it("swallows a write error so a tracking miss never breaks the sweep", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "write failed" } });
    await expect(saveScanOffset("k", 200)).resolves.toBeUndefined();
  });
});

describe("rotateSelfhealScan", () => {
  it("passes the stored offset into the sweep and advances on a full page", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { next_offset: 200 }, error: null });
    const run = vi.fn(async (_offset: number) => ({ freed: 5, scanned: LIMIT }));
    const res = await rotateSelfhealScan("k", LIMIT, run);

    expect(run).toHaveBeenCalledWith(200);
    expect(res).toEqual({ freed: 5, scanned: LIMIT });
    // full page at offset 200 -> next offset 400
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ key: "k", next_offset: 400 }));
  });

  it("wraps back to 0 when the sweep returns a short page", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { next_offset: 400 }, error: null });
    const run = vi.fn(async () => ({ recreated: 0, scanned: 12 }));
    await rotateSelfhealScan("k", LIMIT, run);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ key: "k", next_offset: 0 }));
  });

  // Failure path: a sweep that threw tells us nothing about how many rows it
  // scanned. Advancing the cursor would skip that whole page next tick, stranding
  // exactly the rows this rotation exists to cover. So leave the cursor untouched.
  it("does not advance the cursor when the sweep failed (null result)", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { next_offset: 200 }, error: null });
    const run = vi.fn(async () => null);
    const res = await rotateSelfhealScan("k", LIMIT, run);
    expect(res).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
