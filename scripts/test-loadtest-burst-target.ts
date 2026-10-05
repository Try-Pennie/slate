// What pool the burst fires at, and how strong that makes the control (#2278).
//
// The burst leg fires 100 simultaneous requests at ONE slot and the whole control
// rests on that slot's pool being ONE agent deep: contention across three agents
// proves much less than contention on one. Nothing measured it. The code was a
// hand maintained constant (`BURST_CODE`), the seeded roster gave it three, and a
// live run answered three 200s on three different agents, which is correct
// behaviour and a materially weaker control than the one intended.
//
// It rots, too, and did: production's Low plus Beyond pool emptied on 2026-09-10
// (#2152) and the constant had to be moved by hand from 122 to 222 the morning of
// the next run (#2319).
//
// So the pool is MEASURED, the shallowest one that is actually offering times is
// chosen, and the depth it ran at is reported. Two things the design deliberately
// does NOT do:
//
//   - it never FAILS on depth. The judge asks one winner per AGENT (#2273), which
//     is the real invariant and holds at any depth, so a run red because the
//     roster has no one deep pool is red for a property of the roster and is how a
//     check stops being read (L36).
//   - an UNMEASURED depth never renders as a number. "Nobody measured it" and
//     "it was one deep" are the two states this whole issue is about telling
//     apart (L98, L11).
//
// Run: node --experimental-strip-types scripts/test-loadtest-burst-target.ts
import {
  burstCandidateOrder,
  burstControlStrength,
  burstPairOrder,
  ladderSignature,
  poolKeysByCode,
  siblingCodes,
  type PoolRow,
} from "./loadtest/burst-target.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the shallowest pool is asked first -----------------------------------------
{
  const order = burstCandidateOrder(
    [
      { code: "112", depth: 74 },
      { code: "222", depth: 1 },
      { code: "322", depth: 3 },
      { code: "212", depth: 56 },
    ],
    4,
  );
  eq(order[0], "222", "the one agent pool is asked first, because it is the strongest control");
  eq(order[1], "322", "then the next shallowest");
  eq(order.join(","), "222,322,212,112", "and the rest in ascending depth");
}

// --- a pool with nobody in it is never asked -------------------------------------
{
  // It can never offer a time, so asking spends one of the availability reads the
  // setup has to live inside for nothing, and a run of empty answers would end in
  // the "offered nothing" refusal naming the wrong pool.
  const order = burstCandidateOrder(
    [
      { code: "531", depth: 0 },
      { code: "222", depth: 2 },
    ],
    5,
  );
  eq(order.join(","), "222", "an empty pool is not a candidate");
}

// --- the order is stable when depths tie -----------------------------------------
{
  // Two runs against one roster must ask the same question. An order settled by
  // whatever the read happened to return makes the burst's code a different
  // measurement each time, for no reason a reader could see (L419).
  const depths = [
    { code: "422", depth: 1 },
    { code: "122", depth: 1 },
    { code: "322", depth: 1 },
  ];
  eq(burstCandidateOrder(depths, 3).join(","), "122,322,422", "ties break on the code");
  eq(
    burstCandidateOrder([...depths].reverse(), 3).join(","),
    "122,322,422",
    "whatever order the rows arrived in",
  );
}

// --- the number of availability reads is bounded ----------------------------------
{
  // `/api/availability` has its own per address ceiling (30 a minute) and the
  // setup shares that address with everything else the job does.
  const many = Array.from({ length: 60 }, (_, i) => ({ code: `c${i}`, depth: i + 1 }));
  eq(burstCandidateOrder(many, 6).length, 6, "at most the limit is asked");
  eq(burstCandidateOrder(many, 0).length, 0, "and a limit of zero asks nothing");
}

// --- nothing measured means no candidates, never a silent default ------------------
{
  eq(burstCandidateOrder([], 6).length, 0, "no depths, no candidates");
}

// --- what the report says the control actually proved ------------------------------
{
  const one = burstControlStrength({ measured: true, code: "222", depth: 1 });
  assert(/\b1\b|one/i.test(one), "a one deep pool is reported as one deep");
  assert(/222/.test(one), "and names the code it ran at");

  const three = burstControlStrength({ measured: true, code: "322", depth: 3 });
  assert(/\b3\b/.test(three), "a three deep pool reports the three");
  assert(
    three !== one,
    "and does not read like the one deep case, which is the whole point of measuring",
  );
  assert(
    /weaker|less|spread/i.test(three),
    "it says the control is weaker at depth, rather than leaving a reader to work it out",
  );
}

// --- an unmeasured depth says so, and never renders as a number ---------------------
{
  const unknown = burstControlStrength({
    measured: false,
    code: "222",
    why: "no database credentials in this job",
  });
  assert(
    /not measured|unmeasured|unknown/i.test(unknown),
    "an unmeasured depth is reported as unmeasured",
  );
  assert(
    !/\bdepth 0\b|\b0 agents\b|\b1 agent deep\b/.test(unknown),
    "and never as a depth nobody read (L98)",
  );
  assert(
    /no database credentials/.test(unknown),
    "carrying the reason, so a reader knows what to fix",
  );
  assert(
    unknown !== burstControlStrength({ measured: true, code: "222", depth: 1 }),
    "and it does not read like a measured one deep pool",
  );
}

// --- the burst is split across two codes of ONE fallback ladder (#3325) ------------
//
// The shared confirm line keys a crowd on the whole fallback LADDER, so a follower is
// only ever told "taken" by a leader who walked the same pools at every rung. The
// burst splits across two codes whose ladders are the same pools at every rung, so
// the line is proved across codes and not only within one. Which codes qualify is
// MEASURED from the branch's own bucket rows, through the booker's own ladder and the
// recompute lane's own pool key, never assumed: on today's matrix two codes differing
// only in the legal digit qualify, and a bucket given a hand named member must stop
// qualifying the moment it is.

/** The sixty buckets as the load test seed writes them: one org, one event type. */
function seededRows(edit: (row: PoolRow) => PoolRow = (r) => r): PoolRow[] {
  return allXbcCodes().map((code) =>
    edit({
      code,
      orgId: "org",
      eventTypeId: "evt",
      criteria: bucketSpecForXbc(code)!.criteria,
      fallbackUserId: null,
      memberIds: [],
    }),
  );
}

{
  const keys = poolKeysByCode(seededRows());
  eq(keys.size, 60, "every seeded code has a pool key");
  eq(siblingCodes("122", keys), ["120", "121"], "on the seeded matrix the legal digit is inert, so 120 and 121 share 122's ladder");
  eq(siblingCodes("120", keys), ["121", "122"], "and the relation is the same from either end");
  eq(siblingCodes("112", keys), ["100", "101", "102", "110", "111"], "the whole tier codes share a one rung ladder too");
  assert(!siblingCodes("122", keys).includes("132"), "a different backend is a different ladder");
  assert(!siblingCodes("122", keys).includes("222"), "and so is a different tier");
}

{
  // A hand named member changes who a bucket routes to, so it changes the pool key
  // and the bucket splits off its siblings at once.
  const keys = poolKeysByCode(seededRows((r) => (r.code === "121" ? { ...r, memberIds: ["agent-9"] } : r)));
  eq(siblingCodes("122", keys), ["120"], "a bucket with a hand named member is no longer a sibling");
}

{
  // At EVERY rung, not only the first. 120 and 122 start on the same pool, but if
  // the whole tier rung they fall back to differs (110 against 112), a follower on
  // one could be told taken by a leader who walked a different pool.
  const keys = poolKeysByCode(seededRows((r) => (r.code === "110" ? { ...r, fallbackUserId: "agent-4" } : r)));
  assert(!siblingCodes("122", keys).includes("120"), "two codes whose LOWER rungs differ are not siblings");
  assert(siblingCodes("122", keys).includes("121"), "while a code whose every rung matches still is");
}

{
  // The Low exclusion is part of the ladder. With every bucket made the same pool, a
  // top tier code and one below it still walk the rungs differently, because a top
  // tier lead's lower rungs skip advisors who also carry Low (#2842).
  const keys = poolKeysByCode(seededRows((r) => ({ ...r, criteria: { debt_team: "low" } })));
  assert(!siblingCodes("322", keys).includes("422"), "a top tier ladder never matches one below it");
  assert(ladderSignature("422", keys) !== null, "and both ladders are readable");
}

{
  // A rung with no bucket is a GAP, part of the ladder's identity, exactly as the
  // confirm path's own key reads it (`ladderGroupOf`, #3325): the burst must pick codes
  // production really puts in one line. So a code whose ladder crosses the gap differs
  // from the same ladder with that rung filled.
  const full = poolKeysByCode(seededRows());
  const gapped = poolKeysByCode(seededRows().filter((r) => r.code !== "132"));
  assert(ladderSignature("122", gapped) !== null, "a ladder with a gap still has a signature");
  assert(ladderSignature("122", gapped) !== ladderSignature("122", full), "and a different one from the ladder with that rung filled");
  eq(ladderSignature("122", gapped), ladderSignature("122", gapped), "and the same gap always gives the same signature");
}

{
  // Shallowest pool first, among the codes that HAVE a sibling, each paired with its
  // first sibling in code order so two runs against one roster pick the same pair.
  const keys = poolKeysByCode(
    seededRows((r) => (r.code === "321" || r.code === "320" ? { ...r, memberIds: [`m-${r.code}`] } : r)),
  );
  const pairs = burstPairOrder(
    [
      { code: "322", depth: 1 },
      { code: "122", depth: 1 },
      { code: "112", depth: 40 },
      { code: "222", depth: 0 },
    ],
    keys,
    6,
  );
  eq(
    pairs,
    [
      { code: "122", sibling: "120" },
      { code: "112", sibling: "100" },
    ],
    "a one deep code whose siblings all split off is skipped, and an empty pool is never asked",
  );
  eq(burstPairOrder([{ code: "122", depth: 1 }], keys, 0), [], "a limit of zero asks nothing");
}

{
  // ONE pair per ladder. Siblings resolve to the same pools, so they offer the same
  // times: asking 121 with 120 after 120 with 121 spends two availability reads on an
  // answer already known, and pushes a genuinely different pool out of the bounded
  // walk. Measured on the seeded roster, the first three candidates were all one
  // ladder before this.
  const keys = poolKeysByCode(seededRows());
  const pairs = burstPairOrder(
    ["120", "121", "122", "220", "221", "222", "320"].map((code) => ({ code, depth: 1 })),
    keys,
    6,
  );
  eq(
    pairs,
    [
      { code: "120", sibling: "121" },
      { code: "220", sibling: "221" },
      { code: "320", sibling: "321" },
    ],
    "each ladder is asked about once, by its first code",
  );
}

finish();
