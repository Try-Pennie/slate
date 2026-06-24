// Pure logic for the routing fairness report (#348): availability-corrected
// per-agent fairness computed from each booking's `routing_trace.considered`
// (the free, eligible candidate set). The point: an agent only accrues
// "expected" bookings for slots they were actually a candidate for, so an agent
// who is rarely free is judged fairly instead of looking under-served by raw
// count. Run: node --experimental-strip-types scripts/test-routing-fairness.ts
import {
  computeFairness,
  type TraceRow,
} from "../src/lib/availability/fairness.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};
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
  ok(b411.bookings === 4 && b411.insufficient === false, "bucket 411: 4 bookings, enough to judge");
  const b412 = out.buckets.find((b) => b.bucketCode === "412")!;
  ok(b412.bookings === 1 && b412.insufficient === true, "bucket 412: 1 booking -> flagged insufficient (small-n)");
}

// --- the agent math (availability-corrected) ---
{
  const b411 = out.buckets.find((b) => b.bucketCode === "411")!;
  const A = b411.agents.find((a) => a.userId === "A")!;
  const B = b411.agents.find((a) => a.userId === "B")!;
  const C = b411.agents.find((a) => a.userId === "C")!;

  ok(A.opportunities === 4 && A.received === 2, "A was a candidate in all 4, got 2");
  ok(approx(A.expected, 1.667) && approx(A.deviation, 0.333), "A: expected ~1.67 (1/2+1/2+1/3+1/3), slightly over");

  ok(B.opportunities === 4 && B.received === 1, "B was a candidate in all 4, got 1");
  ok(approx(B.deviation, -0.667), "B is the genuinely under-served one (deviation ~ -0.67)");

  // The key availability correction: C only had 2 opportunities, so getting 1 is
  // FAIR, not under-served, even though C has fewer total bookings than A.
  ok(C.opportunities === 2 && C.received === 1, "C was a candidate in only 2 (rarely free), got 1");
  ok(approx(C.expected, 0.667) && approx(C.deviation, 0.333), "C is judged FAIR despite fewer bookings (availability-corrected)");

  // Received and expected each sum to the bucket's bookings.
  const sumRecv = b411.agents.reduce((s, a) => s + a.received, 0);
  const sumExp = b411.agents.reduce((s, a) => s + a.expected, 0);
  ok(sumRecv === 4 && approx(sumExp, 4), "received and expected both sum to the bucket's total bookings");
}

// --- per-agent roll-up across buckets (commission-relevant total) ---
{
  const A = out.byAgent.find((a) => a.userId === "A")!;
  // A: bucket 411 received 2 + bucket 412 received 1 = 3 across pools.
  ok(A.received === 3, "roll-up sums an agent's received bookings across all buckets");
  ok(approx(A.expected, 1.667 + 0.5), "roll-up sums expected across buckets too (412 adds 0.5)");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
