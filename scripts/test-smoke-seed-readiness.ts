// The seed's dry run MEASURES whether a test bucket is ready, and says which of
// four things is missing (#2660).
//
// "Seeded" used to be a printed line: the dry run listed the rows it would write
// and exited 0 whatever the database held. A partner meeting "Unknown bucket"
// could not tell "not seeded yet" from "the recompute has not run yet" from "the
// row lost its member", and the person running the seed could not either. Each
// state is its own exit code, because each sends somebody to do a different
// thing (L11, L184), and finding nothing is never a pass (L98).
//
// Run: node --experimental-strip-types scripts/test-smoke-seed-readiness.ts
import {
  judgeSeedReadiness,
  READINESS_EXIT,
  worstReadiness,
  type SeedReadinessState,
} from "./lib/smoke-seed-readiness.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ready = judgeSeedReadiness({
  code: "X",
  bucket: { id: "b1", is_test: true },
  activeMembers: 1,
  slotRow: { computed_at: "2026-09-24T10:00:00Z" },
});
eq(ready.state, "ready", "a flagged bucket with a member and a published slot row is ready");
eq(READINESS_EXIT[ready.state], 0, "and ready is the only state that exits 0");

eq(
  judgeSeedReadiness({ code: "X", bucket: null, activeMembers: 0, slotRow: null }).state,
  "no-bucket",
  "no row at all is the first thing to say, before members or slots",
);
eq(
  judgeSeedReadiness({ code: "X", bucket: { id: "b1", is_test: false }, activeMembers: 1, slotRow: { computed_at: "t" } }).state,
  "not-test",
  "a row that is NOT flagged is_test is refused above everything else: a public bucket without the flag fires real webhooks",
);
eq(
  judgeSeedReadiness({ code: "X", bucket: { id: "b1", is_test: true }, activeMembers: 0, slotRow: { computed_at: "t" } }).state,
  "no-member",
  "a bucket nobody serves is named as such, not as unseeded",
);
eq(
  judgeSeedReadiness({ code: "X", bucket: { id: "b1", is_test: true }, activeMembers: 1, slotRow: null }).state,
  "no-slots",
  "a seeded bucket the recompute has not published yet is its own state, so it is not read as a failed seed",
);

// Every state has its own exit code and its own sentence, and nothing shares
// either: two states with one code would send the reader to one repair for two
// faults.
{
  const states: SeedReadinessState[] = ["ready", "no-bucket", "not-test", "no-member", "no-slots"];
  const exits = states.map((s) => READINESS_EXIT[s]);
  eq(new Set(exits).size, states.length, "every state exits on its own code");
  assert(exits.every((e) => e !== 1), "none reuses exit 1, which the seed uses for its own crash");
  const messages = states.map(
    (state) =>
      judgeSeedReadiness({
        code: "X",
        bucket: state === "no-bucket" ? null : { id: "b1", is_test: state !== "not-test" },
        activeMembers: state === "no-member" ? 0 : 1,
        slotRow: state === "no-slots" ? null : { computed_at: "t" },
      }).message,
  );
  eq(new Set(messages).size, states.length, "every state says something different");
  for (const m of messages) assert(m.includes("X"), `the message names the bucket code (${m})`);
}

// The sweep exits on its WORST row: one unpublished bucket among ready ones is
// the finding, and a bucket with no row outranks one with no slots.
{
  const rows = [
    judgeSeedReadiness({ code: "A", bucket: { id: "a", is_test: true }, activeMembers: 1, slotRow: { computed_at: "t" } }),
    judgeSeedReadiness({ code: "B", bucket: { id: "b", is_test: true }, activeMembers: 1, slotRow: null }),
    judgeSeedReadiness({ code: "C", bucket: null, activeMembers: 0, slotRow: null }),
  ];
  const worst = worstReadiness(rows);
  eq(worst.state, "no-bucket", "the missing row outranks the unpublished one");
  eq(worst.exit, READINESS_EXIT["no-bucket"], "and the exit code is that state's");
  eq(worstReadiness([rows[0]!]).exit, 0, "a sweep of ready rows exits 0");
  eq(worstReadiness([]).state, "nothing-judged", "judging no rows is not a pass");
  assert(worstReadiness([]).exit !== 0, "and exits non zero");
}

finish();
