// Pure logic for the routing fairness report (#348): availability-corrected
// per-agent fairness computed from each booking's `routing_trace.considered`
// (the free, eligible candidate set). The point: an agent only accrues
// "expected" bookings for slots they were actually a candidate for, so an agent
// who is rarely free is judged fairly instead of looking under-served by raw
// count. Run: node --experimental-strip-types scripts/test-routing-fairness.ts
import {
  computeFairness,
  excludeTestEntities,
  type TraceRow,
} from "../src/lib/availability/fairness.ts";
import { assert, finish } from "./lib/harness.ts";

const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// Bucket 411: 4 bookings among A, B, C. C is only free for 2 of them.
//   bk1 considered [A,B] -> A
//   bk2 considered [A,B] -> B
//   bk3 considered [A,B,C] -> A
//   bk4 considered [A,B,C] -> C
const rows: TraceRow[] = [
  { bucketCode: "411", chosenUserId: "A", considered: ["A", "B"] },
  { bucketCode: "411", chosenUserId: "B", considered: ["A", "B"] },
  { bucketCode: "411", chosenUserId: "A", considered: ["A", "B", "C"] },
  { bucketCode: "411", chosenUserId: "C", considered: ["A", "B", "C"] },
  // Bucket 412: a single booking -> too small to judge.
  { bucketCode: "412", chosenUserId: "A", considered: ["A", "B"] },
];

const out = computeFairness(rows, { minBookings: 3 });

// --- per-bucket structure ---
{
  const b411 = out.buckets.find((b) => b.bucketCode === "411")!;
  assert(b411.bookings === 4 && b411.insufficient === false, "bucket 411: 4 bookings, enough to judge");
  const b412 = out.buckets.find((b) => b.bucketCode === "412")!;
  assert(b412.bookings === 1 && b412.insufficient === true, "bucket 412: 1 booking -> flagged insufficient (small-n)");
}

// --- the agent math (availability-corrected) ---
{
  const b411 = out.buckets.find((b) => b.bucketCode === "411")!;
  const A = b411.agents.find((a) => a.userId === "A")!;
  const B = b411.agents.find((a) => a.userId === "B")!;
  const C = b411.agents.find((a) => a.userId === "C")!;

  assert(A.opportunities === 4 && A.received === 2, "A was a candidate in all 4, got 2");
  assert(approx(A.expected, 1.667) && approx(A.deviation, 0.333), "A: expected ~1.67 (1/2+1/2+1/3+1/3), slightly over");

  assert(B.opportunities === 4 && B.received === 1, "B was a candidate in all 4, got 1");
  assert(approx(B.deviation, -0.667), "B is the genuinely under-served one (deviation ~ -0.67)");

  // The key availability correction: C only had 2 opportunities, so getting 1 is
  // FAIR, not under-served, even though C has fewer total bookings than A.
  assert(C.opportunities === 2 && C.received === 1, "C was a candidate in only 2 (rarely free), got 1");
  assert(approx(C.expected, 0.667) && approx(C.deviation, 0.333), "C is judged FAIR despite fewer bookings (availability-corrected)");

  // Received and expected each sum to the bucket's bookings.
  const sumRecv = b411.agents.reduce((s, a) => s + a.received, 0);
  const sumExp = b411.agents.reduce((s, a) => s + a.expected, 0);
  assert(sumRecv === 4 && approx(sumExp, 4), "received and expected both sum to the bucket's total bookings");
}

// --- per-agent roll-up across buckets (commission-relevant total) ---
{
  const A = out.byAgent.find((a) => a.userId === "A")!;
  // A: bucket 411 received 2 + bucket 412 received 1 = 3 across pools.
  assert(A.received === 3, "roll-up sums an agent's received bookings across all buckets");
  assert(approx(A.expected, 1.667 + 0.5), "roll-up sums expected across buckets too (412 adds 0.5)");
  // Without rawAssignments, rawReceived defaults to 0 (back-compat, #424).
  assert(A.rawReceived === 0, "rawReceived defaults to 0 when no raw assignments are supplied");
}

// --- raw bookings-received total (#424) -------------------------------------
// The router-fairness math counts only ranker decisions, so an agent who gets
// bookings via manual reassign or reschedule is under-counted in the
// commission-relevant total. `rawAssignments` carries EVERY booking's current
// assigned_user_id (regardless of routing_trace) so the rollup can report the
// true count alongside the availability-corrected one.
{
  // The 5 ranker bookings above resolve to A,B,A,C,A; plus a booking reassigned
  // to D (never a ranker candidate) and one A received via reschedule.
  const rawAssignments = ["A", "B", "A", "C", "A", "D", "A"];
  const withRaw = computeFairness(rows, { minBookings: 3, rawAssignments });

  const A = withRaw.byAgent.find((a) => a.userId === "A")!;
  const B = withRaw.byAgent.find((a) => a.userId === "B")!;
  const C = withRaw.byAgent.find((a) => a.userId === "C")!;
  const D = withRaw.byAgent.find((a) => a.userId === "D");

  assert(A.received === 3 && A.rawReceived === 4, "A: router-assigned 3, raw 4 (3 ranker + 1 reschedule)");
  assert(B.received === 1 && B.rawReceived === 1, "B: router-assigned 1, raw 1");
  assert(C.received === 1 && C.rawReceived === 1, "C: router-assigned 1, raw 1");
  // D only ever appeared via a manual reassign: zero ranker credit, but the raw
  // total must still surface the booking so commission isn't mis-stated.
  assert(!!D, "an agent who only received via reassign still appears in the rollup");
  assert(
    !!D && D.received === 0 && approx(D.expected, 0) && D.rawReceived === 1,
    "D: no router candidacy (received/expected 0) but rawReceived 1",
  );
  // The router-fairness numbers are unchanged by adding the raw total.
  assert(approx(A.expected, 1.667 + 0.5), "supplying rawAssignments leaves the router-fairness math untouched");

  // A malformed empty id is filtered, not turned into a phantom agent.
  const withEmpty = computeFairness(rows, { minBookings: 3, rawAssignments: ["", "A"] });
  assert(withEmpty.byAgent.find((a) => a.userId === "") === undefined, "empty-string assigned_user_id is filtered out of the rollup");
}

// --- exclude synthetic test entities (#460) ---------------------------------
// Cross-bucket and org-wide fairness reporting must not count the synthetic
// smoke-test agent or its isolated test buckets. excludeTestEntities strips the
// synthetic rows (a booking in a test bucket, or one won by a test agent) and
// the synthetic raw assignments BEFORE the availability-corrected math runs, so
// a hidden test entity can never distort the report.
{
  const realRaw = ["A", "B"];
  const baseline = computeFairness(rows, { minBookings: 3, rawAssignments: realRaw });

  // The real bookings above, plus one booking in the isolated SMOKE bucket won
  // by the synthetic agent, and two of that agent's raw bookings.
  const mixed: TraceRow[] = [
    ...rows,
    { bucketCode: "SMOKE", chosenUserId: "SMOKE_AGENT", considered: ["SMOKE_AGENT", "SMOKE2_AGENT"] },
  ];
  const mixedRaw = [...realRaw, "SMOKE_AGENT", "SMOKE_AGENT"];

  const cleaned = excludeTestEntities(mixed, mixedRaw, {
    testUserIds: ["SMOKE_AGENT", "SMOKE2_AGENT"],
    testBucketCodes: ["SMOKE"],
  });

  // The synthetic rows and raw assignments are gone; only the real ones remain.
  assert(cleaned.rows.every((r) => r.bucketCode !== "SMOKE"), "a booking in a test bucket is dropped from the fairness rows");
  assert(
    cleaned.rawAssignments.every((id) => id !== "SMOKE_AGENT" && id !== "SMOKE2_AGENT"),
    "the test agents' raw bookings are excluded from the commission total",
  );

  // The edge case that matters: a mix of test and real bookings yields exactly
  // the real-only report, agent for agent and bucket for bucket.
  const report = computeFairness(cleaned.rows, { minBookings: 3, rawAssignments: cleaned.rawAssignments });
  assert(
    JSON.stringify(report) === JSON.stringify(baseline),
    "a mix of test and real bookings produces exactly the real-only report (no synthetic rows counted)",
  );
  assert(report.byAgent.every((a) => a.userId !== "SMOKE_AGENT"), "the smoke-test agent never appears in the per-agent rollup");
  assert(report.buckets.every((b) => b.bucketCode !== "SMOKE"), "the isolated test bucket never appears as a report row");

  // Defensive: a test agent that somehow appears in a REAL bucket is stripped
  // from the candidate set while the real booking itself is kept and re-scored.
  const defensive = excludeTestEntities(
    [{ bucketCode: "411", chosenUserId: "A", considered: ["A", "SMOKE_AGENT"] }],
    [],
    { testUserIds: ["SMOKE_AGENT"], testBucketCodes: [] },
  );
  assert(
    defensive.rows.length === 1 && JSON.stringify(defensive.rows[0].considered) === JSON.stringify(["A"]),
    "a test agent in a real bucket's candidate set is stripped, keeping the real row",
  );

  // Defensive: a booking WON by a test agent is dropped even outside a test
  // bucket, so its ranker credit never lands on the synthetic agent.
  const chosenByTest = excludeTestEntities(
    [{ bucketCode: "411", chosenUserId: "SMOKE_AGENT", considered: ["SMOKE_AGENT", "A"] }],
    [],
    { testUserIds: ["SMOKE_AGENT"], testBucketCodes: [] },
  );
  assert(chosenByTest.rows.length === 0, "a booking won by a test agent is dropped even outside a test bucket");
}

finish();
