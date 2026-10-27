// #3582 Phase 4: the FILTERED demotion snapshot join, pure so every branch is driven here.
//
// `selectDemotionBookings` turns the four raw reads (the agent's current attributes, their
// upcoming bookings with each booking's bucket and kind, the criteria of those buckets, and
// the buckets the agent is a manual member of) into the CoverageBookingRow set a demotion
// sweep must move: only the bookings the agent no longer serves, and never an agent_link one.
// It shares `agentStillServes` (through `unservedBookingIds`) so it can never judge
// eligibility differently from the booker (L263, L342). The join itself is what this pins:
// criteria looked up by bucket_id, manual membership by set, and the null-attributes fail-safe.
import {
  assembleDemotionSnapshot,
  assembleRerouteCandidates,
  callsTakenAgain,
  criteriaMapOrThrow,
  selectDemotionBookings,
  toRerouteCandidates,
} from "../src/lib/booking/demotion-snapshot.ts";
import type { DemotionCandidateRow, DemotionSnapshotReaders } from "../src/lib/booking/demotion-snapshot.ts";
import type { Attributes, Criteria } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function row(id: string, bucketId: string, kind = "round_robin"): DemotionCandidateRow {
  return {
    id,
    bucket_id: bucketId,
    kind,
    starts_at: "2026-10-20T15:00:00.000Z",
    ends_at: "2026-10-20T15:30:00.000Z",
    attendee_name: `lead-${id}`,
  };
}

const criteriaByBucket = new Map<string, Criteria | null>([
  ["b-uh", { debt_team: "ultra_high" }],
  ["b-hi", { debt_team: "high" }],
]);

{
  // The partial case coverageBookings cannot express: demoted off ultra_high but kept high.
  // Only the ultra_high booking is in the snapshot; the still-served high one is not. The
  // returned rows are CoverageBookingRow (no bucket_id / kind leaking through).
  const out = selectDemotionBookings(
    { debt_team: ["high"] },
    [row("uh1", "b-uh"), row("hi1", "b-hi")],
    criteriaByBucket,
    new Set<string>(),
  );
  eq(out.map((r) => r.id).join(","), "uh1", "snapshot keeps only the booking in the lost pool");
  eq(out[0].attendee_name, "lead-uh1", "snapshot carries the row fields a notice names");
  eq((out[0] as Record<string, unknown>).bucket_id, undefined, "snapshot does not leak bucket_id");
}

{
  // A manual member of the lost bucket keeps serving it, so their booking is NOT in the
  // snapshot even though their tier narrowed (membership decides, not attributes).
  const out = selectDemotionBookings(
    { debt_team: ["high"] },
    [row("uh1", "b-uh")],
    criteriaByBucket,
    new Set<string>(["b-uh"]),
  );
  eq(out.length, 0, "a manual member's booking is not in the snapshot");
}

{
  // agent_link is excluded (the lead chose the advisor by name).
  const out = selectDemotionBookings(
    { debt_team: ["high"] },
    [row("al1", "b-uh", "agent_link")],
    criteriaByBucket,
    new Set<string>(),
  );
  eq(out.length, 0, "an agent_link booking is never in the snapshot");
}

{
  // An agent still serving everything they hold yields an empty snapshot (a born-done job).
  const out = selectDemotionBookings(
    { debt_team: ["ultra_high", "high"] },
    [row("uh1", "b-uh"), row("hi1", "b-hi")],
    criteriaByBucket,
    new Set<string>(),
  );
  eq(out.length, 0, "an agent still serving every held booking yields an empty snapshot");
}

{
  // THE FAIL-SAFE: null current attributes (a failed users read) moves NOBODY, so a bad read
  // can never mass-reroute a roster (L214, L50).
  const out = selectDemotionBookings(null, [row("uh1", "b-uh")], criteriaByBucket, new Set<string>());
  eq(out.length, 0, "null (unknown) current attributes move nobody");
}

{
  // A booking whose bucket has no criteria row (a stale/missing bucket): a demotion must not
  // guess. An absent criteria entry reads as null, and a null criterion means the agent does
  // NOT still serve it, so it moves. A missing bucket biases toward moving (the harmless
  // side: a wrongly-moved booking is recoverable by the admin undo; a wrongly-kept one
  // strands a customer with an ineligible advisor) (L648).
  const out = selectDemotionBookings(
    { debt_team: ["high"] } as Attributes,
    [row("x1", "b-missing")],
    criteriaByBucket,
    new Set<string>(),
  );
  eq(out.map((r) => r.id).join(","), "x1", "a booking whose bucket criteria are missing is moved, not silently kept");
}

// --- assembleDemotionSnapshot (the orchestration over the four reads) ------

function readers(over: Partial<DemotionSnapshotReaders>): DemotionSnapshotReaders {
  return {
    candidates: async () => [row("uh1", "b-uh"), row("hi1", "b-hi")],
    agentAttributes: async () => ({ debt_team: ["high"] }),
    bucketCriteria: async () => criteriaByBucket,
    manualMemberBucketIds: async () => new Set<string>(),
    pinnedBookingIds: async () => new Set<string>(),
    ...over,
  };
}

{
  // The happy path reads all four and filters to the lost-pool booking.
  const out = await assembleDemotionSnapshot(readers({}));
  eq(out.map((r) => r.id).join(","), "uh1", "assemble filters to the booking in the lost pool");
}

{
  // No upcoming bookings short-circuits: the other three reads never run, so an agent holding
  // nothing costs a single query, not four, on the shared cron budget.
  let attrsRead = false;
  let criteriaRead = false;
  let membersRead = false;
  const out = await assembleDemotionSnapshot(
    readers({
      candidates: async () => [],
      agentAttributes: async () => {
        attrsRead = true;
        return {};
      },
      bucketCriteria: async () => {
        criteriaRead = true;
        return new Map();
      },
      manualMemberBucketIds: async () => {
        membersRead = true;
        return new Set();
      },
    }),
  );
  eq(out.length, 0, "no upcoming bookings yields an empty snapshot");
  assert(!attrsRead && !criteriaRead && !membersRead, "no further reads run when the agent holds nothing");
}

{
  // bucketCriteria is asked for the DISTINCT bucket ids, not one per booking: two bookings in
  // one bucket ask for that bucket once.
  let asked: string[] = [];
  await assembleDemotionSnapshot(
    readers({
      candidates: async () => [row("a", "b-uh"), row("b", "b-uh"), row("c", "b-hi")],
      bucketCriteria: async (ids) => {
        asked = [...ids].sort();
        return criteriaByBucket;
      },
    }),
  );
  eq(asked.join(","), "b-hi,b-uh", "bucket criteria are read once per distinct bucket");
}

{
  // FAIL LOUD: a reader that throws (a failed query) propagates, so a demotion snapshot is
  // never built from a partial read. A silent empty/partial here would either move nobody when
  // a real narrowing happened, or (worse) move the wrong set (L184, fail-loud).
  let threw = false;
  try {
    await assembleDemotionSnapshot(
      readers({
        bucketCriteria: async () => {
          throw new Error("buckets read failed");
        },
      }),
    );
  } catch {
    threw = true;
  }
  assert(threw, "a failed read aborts the snapshot rather than returning a partial one");
}

// --- criteriaMapOrThrow (completeness of the buckets read) -----------------

{
  // A complete read builds the map, and a GENUINELY empty-criteria bucket is present with a
  // null value (served only via manual membership), NOT treated as missing.
  const map = criteriaMapOrThrow(
    ["b-uh", "b-empty"],
    [
      { id: "b-uh", criteria: { debt_team: "ultra_high" } },
      { id: "b-empty", criteria: null },
    ],
  );
  eq(map.size, 2, "a complete read builds every requested bucket");
  eq(map.get("b-empty"), null, "an empty-criteria bucket is present with a null value, not missing");
}

{
  // FAIL LOUD: a short read (a requested bucket missing from the result) throws, so a demotion
  // snapshot is never built from a partial buckets read and cannot mass-move (L214, L184).
  let threw = false;
  try {
    criteriaMapOrThrow(["b-uh", "b-hi"], [{ id: "b-uh", criteria: { debt_team: "ultra_high" } }]);
  } catch {
    threw = true;
  }
  assert(threw, "a buckets read missing a requested bucket throws rather than returning a partial map");
}

// --- toRerouteCandidates / assembleRerouteCandidates (the decision's candidates) ---

{
  // The join: criteria looked up by bucket_id, manual membership by set, kind carried through.
  const out = toRerouteCandidates(
    [row("a", "b-uh"), row("m", "b-hi"), row("al", "b-uh", "agent_link")],
    criteriaByBucket,
    new Set<string>(["b-hi"]),
  );
  eq(out.length, 3, "one candidate per booking (no filtering, unlike the snapshot)");
  eq(JSON.stringify(out[0].criteria), JSON.stringify({ debt_team: "ultra_high" }), "criteria looked up by bucket_id");
  assert(out[1].isManualMember, "manual membership resolved by set");
  assert(!out[0].isManualMember, "a non-member reads as not a manual member");
  eq(out[2].kind, "agent_link", "the kind is carried through for the decision to exclude");
}

{
  // assembleRerouteCandidates reads candidates + criteria + members (NOT attributes) and joins.
  let attrsAsked = false;
  const out = await assembleRerouteCandidates({
    candidates: async () => [row("a", "b-uh"), row("b", "b-uh")],
    bucketCriteria: async (ids) => {
      attrsAsked = ids.length > 0; // just to use ids
      return criteriaByBucket;
    },
    manualMemberBucketIds: async () => new Set<string>(),
    pinnedBookingIds: async () => new Set<string>(),
  });
  eq(out.map((c) => c.bookingId).join(","), "a,b", "returns every held booking as a candidate");
  assert(attrsAsked, "it reads bucket criteria for the referenced buckets");
}

{
  // No bookings short-circuits with no further reads.
  let criteriaRead = false;
  const out = await assembleRerouteCandidates({
    candidates: async () => [],
    bucketCriteria: async () => {
      criteriaRead = true;
      return new Map();
    },
    manualMemberBucketIds: async () => new Set(),
    pinnedBookingIds: async () => {
      criteriaRead = true;
      return new Set();
    },
  });
  eq(out.length, 0, "no bookings yields no candidates");
  assert(!criteriaRead, "and reads nothing further");
}

// --- #3615: a call an admin moved BACK stays with that advisor ---------------------------
//
// Dan, 2026-10-11: the admin's choice stands. Left in, the next demotion sweep would move it
// again and the backstop would page about it every day. Dropped from the SHARED candidate read,
// so the sweep's snapshot and the decision cannot disagree about it (L342).

{
  const out = await assembleDemotionSnapshot(readers({ pinnedBookingIds: async () => new Set(["uh1"]) }));
  eq(out.length, 0, "a moved back call is never snapshotted to move again");
}

{
  const out = await assembleRerouteCandidates({
    candidates: async () => [row("a", "b-uh"), row("b", "b-uh")],
    bucketCriteria: async () => criteriaByBucket,
    manualMemberBucketIds: async () => new Set<string>(),
    pinnedBookingIds: async () => new Set(["a"]),
  });
  eq(out.map((c) => c.bookingId).join(","), "b", "nor is it a candidate the decision weighs");
}

{
  // The pinned read is asked only when the agent holds something, like the other reads.
  let asked = false;
  await assembleDemotionSnapshot(
    readers({
      candidates: async () => [],
      pinnedBookingIds: async () => {
        asked = true;
        return new Set();
      },
    }),
  );
  assert(!asked, "an agent holding nothing costs no pinned read");
}

{
  // #4052: a call a demotion sweep could not place stays with the demoted advisor, and the
  // advisor can get the tier back (2026-10-21: Medium removed at 3 PM ET, restored that
  // evening). The call is then theirs to take again and must not be moved, judged by the
  // SAME unserved set the sweep moved by (L342): taken again means the advisor's tiers were
  // read and the call is no longer among the ones they cannot serve.
  const calls = [
    { bookingId: "c1", outUserId: "regained" },
    { bookingId: "c2", outUserId: "still-out" },
    { bookingId: "c3", outUserId: "unread" },
    { bookingId: "c4", outUserId: "never-asked" },
  ];
  const unservedNow = new Map<string, ReadonlySet<string> | null>([
    ["regained", new Set<string>()],
    ["still-out", new Set(["c2"])],
    ["unread", null],
  ]);
  eq([...callsTakenAgain(calls, unservedNow)].join(","), "c1", "only the call its advisor can serve again is taken again");
  assert(
    !callsTakenAgain(calls, unservedNow).has("c3"),
    "an advisor whose tiers could not be read keeps today's behaviour: the call is not taken again",
  );
  assert(!callsTakenAgain(calls, unservedNow).has("c4"), "nor is one whose advisor was never read");
  eq(callsTakenAgain([], unservedNow).size, 0, "no calls, nothing taken again");
}

finish();
