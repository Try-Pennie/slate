import { describe, it, expect, vi, beforeEach } from "vitest";

// #3485 part C: the hourly retry re-arms stranded (unplaceable) coverage calls to pending.
// The one rule that must never slip: the re-arm touches ONLY a still-unplaceable row, so a
// raced `moved` or `cancelled` item can never be re-armed (which would hand a customer to a
// second advisor, or undo a cancelled time off). It also must NOT erase the `detail`
// diagnosis. Supabase is mocked, so this is vitest. The mock records each UPDATE's set
// payload and its filters so the conditions are asserted, not inferred.

interface Update {
  table: string;
  set: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}
const updates: Update[] = [];

function chain(table: string) {
  return {
    update(set: Record<string, unknown>) {
      const filters: Array<[string, unknown]> = [];
      const upd: Record<string, unknown> = {
        in(col: string, val: unknown) {
          filters.push([col, val]);
          return upd;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return upd;
        },
        // reArmUnplaceableItems awaits the update for { count } (count: "exact"). One per chunk.
        then(resolve: (r: { error: null; count: number }) => void) {
          updates.push({ table, set, filters });
          resolve({ error: null, count: 1 });
        },
      };
      return upd;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: (table: string) => chain(table) }),
}));

import { reArmUnplaceableItems } from "./bulk-reassign-store";

const filterCols = (u: Update) => u.filters.map(([c]) => c);

beforeEach(() => {
  updates.length = 0;
});

describe("reArmUnplaceableItems (#3485)", () => {
  it("flips items to pending ONLY where the row is still unplaceable, and keeps the detail", async () => {
    const count = await reArmUnplaceableItems(["i1", "i2"]);
    expect(count).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("bulk_reassign_items");
    expect(updates[0].set).toMatchObject({ status: "pending" });
    // The diagnosis is NOT erased: detail is left as the drain last wrote it.
    expect(updates[0].set).not.toHaveProperty("detail");
    // The safety guard: the UPDATE is conditioned on status = unplaceable and on the ids.
    expect(updates[0].filters).toContainEqual(["status", "unplaceable"]);
    expect(filterCols(updates[0])).toContain("id");
  });

  it("chunks the ids so a long list cannot overflow the URL budget", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `i${i}`);
    const count = await reArmUnplaceableItems(ids);
    expect(updates).toHaveLength(2); // 100 + 50 against RE_ARM_CHUNK
    expect(count).toBe(2); // one counted per chunk by the mock
    for (const u of updates) expect(u.filters).toContainEqual(["status", "unplaceable"]);
  });

  it("writes nothing for an empty id list", async () => {
    const count = await reArmUnplaceableItems([]);
    expect(count).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
