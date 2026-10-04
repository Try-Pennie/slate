import { describe, it, expect, vi } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #3248: the booker's live reroute hold read goes through `live_reroute_holds`, so
// expiry is judged on the DATABASE clock the trigger and the sweep use (L736),
// never the Worker's. What the function decides is proved in a real Postgres by
// `pnpm verify:reroute-holds-sql`; this pins the wiring: the function it calls, the
// buffered window it asks about, and that a failed read throws rather than reading
// as "nobody is held".

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin> }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { loadLiveHolds } from "./service";

const T = (hhmm: string) => Date.parse(`2031-03-04T${hhmm}:00Z`);
const ET = { buffer_before_min: 10, buffer_after_min: 10 };

function withRpc(result: { data: unknown; error: { message: string } | null }) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  dbHolder.db = {
    rpc: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return Promise.resolve(result);
    },
    from: () => {
      throw new Error("the live hold read must not query the table with the Worker's clock");
    },
  } as unknown as ReturnType<typeof supabaseAdmin>;
  return calls;
}

describe("loadLiveHolds", () => {
  it("asks the database function about the call's buffered window, on the database clock", async () => {
    const calls = withRpc({
      data: [
        {
          agent_user_id: "B", booking_id: "K1",
          booking_starts_at: "2031-03-04T15:00:00Z", booking_ends_at: "2031-03-04T15:20:00Z",
          buffered_starts_at: "2031-03-04T14:50:00Z", buffered_ends_at: "2031-03-04T15:30:00Z",
        },
      ],
      error: null,
    });
    const holds = await loadLiveHolds(["A", "B"], T("15:00"), T("15:20"), ET);
    expect(calls).toEqual([
      {
        name: "live_reroute_holds",
        params: { p_user_ids: ["A", "B"], p_from: "2031-03-04T14:50:00.000Z", p_to: "2031-03-04T15:30:00.000Z" },
      },
    ]);
    expect(holds).toEqual([
      { agentUserId: "B", bookingId: "K1", startMs: T("15:00"), endMs: T("15:20"), bufferedStartMs: T("14:50"), bufferedEndMs: T("15:30") },
    ]);
  });

  it("throws on a failed read, never reading it as nobody held", async () => {
    withRpc({ data: null, error: { message: "connection reset" } });
    await expect(loadLiveHolds(["B"], T("15:00"), T("15:20"), ET)).rejects.toThrow(/live reroute holds/);
  });

  it("asks nothing for an empty pool", async () => {
    const calls = withRpc({ data: [], error: null });
    expect(await loadLiveHolds([], T("15:00"), T("15:20"), ET)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
