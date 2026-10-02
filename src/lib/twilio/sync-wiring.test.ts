import { describe, it, expect, vi } from "vitest";

// #3028: the bookable service refuses a flip into the pool for anybody whose STORED
// attributes say Twilio carries Redistribute. The Twilio sync's own reactivation
// reads the tag LIVE, finds it gone, and flips BEFORE it rewrites the stored copy,
// so the row it flips still says tagged. The production wiring therefore has to
// tell the service the tag was read live, or every reactivation is refused for an
// hour and reported as refused. The sync's suite injects its own applyBookable, so
// this is the one place the real wiring is asserted.

const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(async () => ({ status: "applied", userId: "u1", bookable: true })),
}));
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));

import { defaultTwilioSyncDeps } from "./sync";

describe("the Twilio sync's production wiring (#3028)", () => {
  it("tells the bookable service the Redistribute tag was read live", async () => {
    const deps = await defaultTwilioSyncDeps("o1");
    await deps.applyBookable("u1", true);
    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u1", true, undefined, { liveTwilioUntagged: true });
  });
});
