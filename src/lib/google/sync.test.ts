import { describe, it, expect, vi, beforeEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #834: two Google-sync reads were cap-safe only on a data assumption, not a hard
// bound. loadSlateBookingEventIds (one agent's active bookings, no time filter)
// and purgeVanished's reconcile read (one calendar's cached gcal blocks) both now
// page via selectAllPages, so a set that grows past PostgREST's 1,000-row page can
// no longer silently truncate. A truncated dedup set re-mirrors a Slate event as a
// duplicate gcal block (#166); a truncated reconcile set leaves an orphaned block
// over-blocking the agent. These tests drive both reads across the page boundary.

const admin = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin.current }));

import { loadSlateBookingEventIds, purgeVanished } from "./sync";

/**
 * Chainable stand-in for the supabase client that emulates PostgREST paging:
 * `.range(from,to)` returns that window, a read with no range is capped at the
 * first 1,000 rows (the silent cap the real client applies). `.delete().in("id",
 * ids)` records the ids it was asked to remove. `opts.error` makes every read
 * fail so the throw-on-error path can be exercised.
 */
function pagingDb(
  tables: Record<string, Record<string, unknown>[]>,
  opts: { error?: { message: string } } = {},
) {
  const deleted: unknown[] = [];
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    let range: [number, number] | null = null;
    let mode: "read" | "delete" = "read";
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      not: () => b,
      range: (f: number, t: number) => {
        range = [f, t];
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      in: (_col: string, vals: unknown[]) => {
        if (mode === "delete") {
          deleted.push(...vals);
          return Promise.resolve({ error: null });
        }
        return b;
      },
      then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        if (opts.error) return Promise.resolve({ data: null, error: opts.error }).then(resolve);
        const data = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { db: { from } as unknown as ReturnType<typeof supabaseAdmin>, deleted };
}

beforeEach(() => {
  admin.current = null;
});

describe("loadSlateBookingEventIds (#834)", () => {
  it("returns every active-booking event id past the 1,000-row page", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ gcal_event_id: `evt-${i}` }));
    const { db } = pagingDb({ bookings: rows });
    admin.current = db;

    const ids = await loadSlateBookingEventIds("agent-1");

    // The 1,001st id lives on page 2: a single-page read would drop it and the
    // sync would re-mirror that Slate event as a duplicate gcal block.
    expect(ids.size).toBe(1001);
    expect(ids.has("evt-1000")).toBe(true);
  });

  it("throws instead of returning a short set when the read errors", async () => {
    const { db } = pagingDb({ bookings: [] }, { error: { message: "read timeout" } });
    admin.current = db;
    await expect(loadSlateBookingEventIds("agent-1")).rejects.toThrow(/read timeout/);
  });
});

describe("purgeVanished (#834)", () => {
  it("purges a stale gcal block that sits past the 1,000-row page", async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => ({
      id: `b-${i}`,
      gcal_event_id: `evt-${i}`,
    }));
    const { db, deleted } = pagingDb({ busy_blocks: blocks });
    admin.current = db;

    // A full resync that returned NO current events: every cached block is stale
    // and must be purged. The 1,001st block only surfaces if the read paged.
    await purgeVanished("agent-1", "primary", [], new Set());

    expect(deleted).toHaveLength(1001);
    expect(deleted).toContain("b-1000");
  });

  it("throws instead of silently leaving orphaned blocks when the read errors", async () => {
    const { db } = pagingDb({ busy_blocks: [] }, { error: { message: "read timeout" } });
    admin.current = db;
    await expect(purgeVanished("agent-1", "primary", [], new Set())).rejects.toThrow(
      /read timeout/,
    );
  });
});
