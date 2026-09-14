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
import { burstCandidateOrder, burstControlStrength } from "./loadtest/burst-target.ts";
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

finish();
