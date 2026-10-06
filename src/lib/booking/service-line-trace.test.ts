import { describe, it, expect, vi, beforeEach } from "vitest";

// #3354: the REAL wiring hands the route's trace to the shared line's client.
//
// The route mints a trace under the load test and the client stamps every call with
// it, and each half is tested on its own. What neither test can see is the one line
// in `realDeps` that connects them: drop it and both stay green while the object logs
// nothing and the run joins nothing (L3). So that line is driven here.

const built = vi.hoisted(() => ({ traces: [] as unknown[] }));
vi.mock("@/lib/booking/confirm-line-live", () => ({
  confirmLineFor: (_fallback: unknown, _record: unknown, trace: unknown) => {
    built.traces.push(trace);
    return { enter: async () => ({ kind: "unqueued" }), lookahead: async () => null };
  },
  lineGroupOfLive: () => null,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));

import { realDeps } from "./service";

beforeEach(() => {
  built.traces = [];
});

describe("realDeps hands the confirm's trace to its line (#3354)", () => {
  it("passes the trace the route minted", () => {
    realDeps(undefined, { lineTrace: "t-5" });
    expect(built.traces).toEqual(["t-5"]);
  });

  it("passes none when the route minted none, which is every production confirm", () => {
    realDeps(undefined, {});
    realDeps();
    expect(built.traces).toEqual([null, null]);
  });
});
