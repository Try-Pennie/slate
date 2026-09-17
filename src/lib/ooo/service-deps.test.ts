import { describe, it, expect, vi, beforeEach } from "vitest";

// #2482: the REAL time off dependency wiring, driven against a client that refuses.
//
// The orchestration tests inject fakes, which is right for the orchestration and
// leaves this half covered by nothing. Two writes here carried on after a refusal:
//
//   patchRequest, which every status transition goes through. The caller that
//   writes side_effects returns `{ ...request, ...patch }` immediately afterwards,
//   so a refused update left the request in its old state while the Slack message,
//   the calendar events and the cal.com override all proceeded as though it had
//   changed.
//
//   deleteBusyBlock, whose own catch says a slate source leftover is the bad case
//   and alerts on it. That catch was only ever reached by a delete that RAISED, and
//   supabase-js resolves a refusal instead, so the one failure the handler existed
//   to catch was the one it could not see: the block stayed, the agent stayed
//   blocked, and the recompute ran as though they were free.

/** Set to make the next write refuse the way Postgres refuses. */
let writeError: { message: string } | null = null;
const deleted: string[] = [];
const updates: unknown[] = [];

function result() {
  return writeError ? { data: null, error: writeError } : { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      update: (patch: unknown) => ({
        eq: () => {
          updates.push(patch);
          return result();
        },
      }),
      delete: () => {
        const chain = {
          eq: () => {
            deleted.push(table);
            return Object.assign(Promise.resolve(result()), chain);
          },
        };
        return chain;
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: () => ({ select: () => ({ single: async () => result() }) }),
    }),
  }),
}));
vi.mock("@/lib/availability/precompute", () => ({ recomputeBucketsForAgent: vi.fn() }));
vi.mock("@/lib/after", () => ({ afterResponse: (_t: string, fn: () => unknown) => void fn() }));

import { realDeps } from "./service";

beforeEach(() => {
  writeError = null;
  deleted.length = 0;
  updates.length = 0;
});

describe("patchRequest (#2482)", () => {
  it("refuses rather than letting a status transition be reported as made", async () => {
    writeError = { message: "permission denied for table ooo_requests" };
    await expect(realDeps().patchRequest("req-1", { status: "approved" })).rejects.toThrow(
      /permission denied/,
    );
  });

  it("names the request, so a failure says which one", async () => {
    writeError = { message: "deadlock detected" };
    await expect(realDeps().patchRequest("req-88", { status: "rejected" })).rejects.toThrow(
      /req-88/,
    );
  });

  // CONTROL: without this the two above are satisfied by a dep that always throws,
  // which would refuse every approval in the product (L159).
  it("CONTROL: a write that lands returns, and really wrote the patch", async () => {
    await expect(
      realDeps().patchRequest("req-2", { status: "approved" }),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
  });
});
