// Per-bucket equal-share ordering (#305): among agents free for a slot, fewest
// bookings in THIS bucket whose meeting falls in the slot's pay period wins;
// tie-break least-recently-booked then id. A brand-new-to-the-pool agent is
// seeded at the pool's current average so they land mid-pack, not flooded at 0;
// an established-but-quiet agent (had meetings last period) legitimately sorts
// first. Pure; the IO + period filter live in service.ts.
import {
  bucketShareFromResult,
  orderByBucketShare,
  orderByRecency,
  shadowRankingDivergence,
} from "../src/lib/availability/roundrobin.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PERIOD_START = Date.parse("2026-06-15T00:00:00Z");
const inPeriod = "2026-06-18T00:00:00Z"; // >= start
const priorPeriod = "2026-06-10T00:00:00Z"; // < start

// --- bucketShareFromResult ---
// A failed read degrades (never throws): empty counts so the order stays valid
// and the caller fires the alert.
{
  const r = bucketShareFromResult({ data: null, error: { message: "boom" } }, PERIOD_START);
  assert(r.degraded === true, "errored read is degraded");
  assert(Object.keys(r.counts).length === 0 && r.priorActiveIds.length === 0, "degraded read yields empty share");
}
// Rows split by the period boundary: in-period rows count; prior-period rows
// only mark the agent as established (not new).
{
  const r = bucketShareFromResult(
    {
      data: [
        { assigned_user_id: "a", starts_at: inPeriod, created_at: "2026-06-16T10:00:00Z" },
        { assigned_user_id: "a", starts_at: inPeriod, created_at: "2026-06-17T10:00:00Z" },
        { assigned_user_id: "b", starts_at: priorPeriod, created_at: "2026-06-09T10:00:00Z" },
        { assigned_user_id: null, starts_at: inPeriod, created_at: "2026-06-16T10:00:00Z" },
      ],
      error: null,
    },
    PERIOD_START,
  );
  assert(r.counts.a?.count === 2, "counts only in-period bookings per agent");
  assert(r.counts.a?.lastBookedAtMs === Date.parse("2026-06-17T10:00:00Z"), "tracks newest created_at for the tiebreak");
  assert(r.counts.b === undefined, "a prior-period-only agent has no in-period count");
  assert(r.priorActiveIds.includes("b"), "a prior-period booking marks the agent established");
  assert(!("null" in r.counts), "rows with a null assignee are skipped");
}

// --- orderByBucketShare ---
// Fewest count first.
eq(
  orderByBucketShare(["a", "b", "c"], { counts: { a: { count: 3, lastBookedAtMs: 1 }, b: { count: 1, lastBookedAtMs: 1 }, c: { count: 2, lastBookedAtMs: 1 } }, priorActiveIds: ["a", "b", "c"] }),
  ["b", "c", "a"],
  "fewest in-bucket count this period wins",
);
// Tie on count -> least-recently-booked, then id.
eq(
  orderByBucketShare(["a", "b"], { counts: { a: { count: 2, lastBookedAtMs: 500 }, b: { count: 2, lastBookedAtMs: 100 } }, priorActiveIds: ["a", "b"] }),
  ["b", "a"],
  "equal count breaks to least-recently-booked",
);
eq(
  orderByBucketShare(["b", "a"], { counts: { a: { count: 1, lastBookedAtMs: 100 }, b: { count: 1, lastBookedAtMs: 100 } }, priorActiveIds: ["a", "b"] }),
  ["a", "b"],
  "equal count + equal recency breaks to id",
);
// An established-but-quiet agent (count 0, but active last period) legitimately
// sorts FIRST -- they are behind, not new.
eq(
  orderByBucketShare(["a", "d"], { counts: { a: { count: 4, lastBookedAtMs: 1 } }, priorActiveIds: ["a", "d"] }),
  ["d", "a"],
  "established-but-quiet agent (count 0) sorts first, not seeded",
);
// A brand-new agent (count 0, NOT active last period) is seeded at the pool
// average so they land mid-pack, not first. counts a:4,b:2 established -> avg 3;
// new c seeded 3 -> order b(2), c(3), a(4).
eq(
  orderByBucketShare(["a", "b", "c"], { counts: { a: { count: 4, lastBookedAtMs: 1 }, b: { count: 2, lastBookedAtMs: 1 } }, priorActiveIds: ["a", "b"] }),
  ["b", "c", "a"],
  "brand-new agent is seeded at the pool average (lands mid-pack, not flooded)",
);
// Empty / single pass through.
eq(orderByBucketShare([], { counts: {}, priorActiveIds: [] }), [], "empty input yields empty");
eq(orderByBucketShare(["solo"], { counts: {}, priorActiveIds: [] }), ["solo"], "single candidate passes through");

// --- orderByRecency (the prior recency ranker, for shadow comparison, #321) ---
// Pure least-recently-booked: ignores count; never-booked sorts first; tie by id.
eq(
  orderByRecency(["a", "b", "c"], {
    counts: { a: { count: 5, lastBookedAtMs: 100 }, b: { count: 1, lastBookedAtMs: 500 } },
    priorActiveIds: ["a", "b"],
  }),
  ["c", "a", "b"],
  "recency: never-booked first, then least-recently-booked (count ignored)",
);
eq(
  orderByRecency(["b", "a"], {
    counts: { a: { count: 0, lastBookedAtMs: 200 }, b: { count: 0, lastBookedAtMs: 200 } },
    priorActiveIds: [],
  }),
  ["a", "b"],
  "recency: equal recency breaks to id",
);

// --- shadowRankingDivergence (#321): equal-share order + recency order + diverge ---
{
  // count favors b (fewest); recency favors c (never-booked). Tops differ.
  const share = {
    counts: { a: { count: 4, lastBookedAtMs: 100 }, b: { count: 1, lastBookedAtMs: 500 } },
    priorActiveIds: ["a", "b"],
  };
  const d = shadowRankingDivergence(["a", "b", "c"], share);
  assert(d.equalShareTop === "b", "divergence: equal-share top is the fewest-count agent");
  assert(d.recencyTop === "c", "divergence: recency top is the never-booked agent");
  assert(d.diverged === true, "divergence: flagged when the two rankers' tops differ");
  eq(d.recencyOrder, orderByRecency(["a", "b", "c"], share), "divergence: carries the full recency order");
}
{
  // When both rankers agree on the top, diverged is false.
  const share = { counts: { a: { count: 0, lastBookedAtMs: 100 } }, priorActiveIds: ["a", "b"] };
  const d = shadowRankingDivergence(["a", "b"], share);
  assert(d.diverged === false, "divergence: not flagged when tops agree");
}

finish();
