// Which ladders the run's bursts fire at, and why (#2278, #3325, #3429).
//
// The burst used to aim at the shallowest POOL: a crowd of a hundred against a pool one
// agent deep was "exactly one 200 and the rest SLOT_TAKEN" by construction. #3338 made
// a crowd walk the tier ladder like any confirm, so a hundred confirms at a one deep
// code whose lower rungs hold a whole tier mostly WIN, and the refusal path goes
// untested. So the run now fires two kinds of burst, each chosen by MEASURING the
// branch's own roster and buckets through the booker's own predicates (L107):
//
//   - the REFUSAL control fires at the ladder whose WHOLE capacity (distinct advisors
//     across every rung, with the Low exclusion) is the smallest, and only at one
//     genuinely smaller than its crowd. It is the only kind that can refuse anybody.
//   - the DROP burst fires at a ladder whose top rung is the shallowest, whose ladder
//     has a rung below it, and which holds at least twice its crowd, at a slot where
//     the top rung has somebody free and the ladder as a whole has room for everyone.
//
// Each burst is still split across two codes of ONE fallback ladder, so the shared
// confirm line is proved across codes and not only within one (#3325). Which codes
// qualify is measured from the bucket rows, never assumed.
//
// Run: node --experimental-strip-types scripts/test-loadtest-burst-target.ts
import { readBurstPlan, DROP_SLOTS_TO_MEASURE } from "./loadtest/book-plan.ts";
import {
  assembleBurstPlan,
  dropLadders,
  dropSlotFit,
  hardRefusalFit,
  measuredFree,
  chooseRefusalSlots,
  HARD_REFUSAL_MIN_FREE,
  ladderCandidates,
  ladderFreeFrom,
  ladderRosterIds,
  ladderSignature,
  poolKeysByCode,
  refusalLadders,
  siblingCodes,
  type LadderCandidate,
  type PoolRow,
} from "./loadtest/burst-target.ts";
import { generateSeed } from "./loadtest/generate.ts";
import { PRODUCTION_SHAPE } from "./loadtest/roster-shape.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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

/**
 * The roster the load test seed really writes, from the production shape, so the
 * capacities below are the ones a run meets rather than numbers shaped to pass (L48).
 */
const SEEDED_AGENTS = generateSeed({
  agentCount: PRODUCTION_SHAPE.agents,
  orgId: "org",
  nowMs: Date.parse("2026-10-06T12:00:00Z"),
  windowDays: 4,
  blocksPerAgentPerDay: 12,
  shape: PRODUCTION_SHAPE,
}).users.map((u) => ({ id: u.id, attributes: u.attributes }));

// --- the burst is split across two codes of ONE fallback ladder (#3325) ------------
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
  // confirm path's own key reads it (`ladderGroupOf`, #3325).
  const full = poolKeysByCode(seededRows());
  const gapped = poolKeysByCode(seededRows().filter((r) => r.code !== "132"));
  assert(ladderSignature("122", gapped) !== null, "a ladder with a gap still has a signature");
  assert(ladderSignature("122", gapped) !== ladderSignature("122", full), "and a different one from the ladder with that rung filled");
  eq(ladderSignature("122", gapped), ladderSignature("122", gapped), "and the same gap always gives the same signature");
}

// --- #3429: who a ladder can book, from the roster ---------------------------------
{
  const rows = seededRows();
  const byCode = new Map(rows.map((r) => [r.code, r]));
  // 120's ladder is 120, 130, 110: one Beyond advisor on the top rung, and the whole
  // Low tier below it.
  const low = ladderRosterIds("120", byCode, SEEDED_AGENTS);
  eq(low.rung0.length, 1, "120's top rung is the one Beyond advisor on the seeded roster");
  eq(low.ladder.size, 74, "and its whole ladder is the Low tier, 74 advisors");
  // 500's ladder is 500, 400, 300, 200, and below Ultra every rung skips Low carriers
  // (#2842), so the ladder is the sixteen advisors who carry no Low at all.
  const ultra = ladderRosterIds("500", byCode, SEEDED_AGENTS);
  eq(ultra.rung0.length, 6, "500's top rung is the six Ultra advisors");
  eq(ultra.ladder.size, 16, "and its whole ladder is sixteen, because the rungs below skip Low carriers");
  // Control: without the Low exclusion the same ladder would reach nearly everyone,
  // so the sixteen is the exclusion being applied, not a coincidence of the roster.
  const noExclusion = ladderRosterIds("300", byCode, SEEDED_AGENTS);
  assert(noExclusion.ladder.size > 60, `control: a High ladder, which may reach Low, holds far more (got ${noExclusion.ladder.size})`);

  // A rung with no bucket adds nobody, the way the booker skips it.
  const gap = ladderRosterIds("120", new Map(rows.filter((r) => r.code !== "130" && r.code !== "110").map((r) => [r.code, r])), SEEDED_AGENTS);
  eq(gap.ladder.size, 1, "a ladder whose lower rungs have no bucket holds only its top rung");

  // A fallback advisor serves a bucket whose criteria match nobody, as the booker's
  // own eligibility judge says, so it counts toward what the ladder can book.
  const empty = new Map(rows.map((r) => [r.code, r.code === "520" ? { ...r, criteria: { debt_team: "nobody" }, fallbackUserId: SEEDED_AGENTS[0]!.id } : r]));
  eq(ladderRosterIds("520", empty, SEEDED_AGENTS).rung0, [SEEDED_AGENTS[0]!.id], "a fallback advisor is the top rung of a bucket that matches nobody");
}

// --- #3429: the candidates, one per ladder that has a sibling ----------------------
const CANDIDATES = ladderCandidates(seededRows(), SEEDED_AGENTS);
{
  const ladders = new Set(CANDIDATES.map((c) => c.code));
  eq(ladders.size, CANDIDATES.length, "one candidate per code");
  const sigs = new Set(CANDIDATES.map((c) => ladderSignature(c.code, poolKeysByCode(seededRows()))));
  eq(sigs.size, CANDIDATES.length, "and one per LADDER: siblings offer the same times, so a second pair of one ladder asks nothing new");
  const c120 = CANDIDATES.find((c) => c.code === "120");
  eq(c120, { code: "120", sibling: "121", rungs: 3, rung0Roster: 1, ladderRoster: 74 }, "each ladder is named by its first code, with its sibling and what it holds");
  assert(CANDIDATES.every((c) => c.code < c.sibling), "the sibling is the next code of the ladder in code order (L419)");
}

// --- #3429: the refusal control fires at the smallest ladder under its crowd -------
{
  const picked = refusalLadders(CANDIDATES, 100);
  assert(picked.length > 0, "the seeded roster has a ladder smaller than the crowd of a hundred");
  eq(picked[0]!.ladderRoster, 16, "the smallest ladder on the seeded roster holds sixteen");
  eq(picked[0]!.code, "500", "and among the ladders that small, the one with the fewest rungs, then the lowest code, is first");
  assert(picked.every((c) => c.ladderRoster < 100), "every refusal candidate is genuinely smaller than its crowd");
  for (let i = 1; i < picked.length; i++) {
    assert(picked[i - 1]!.ladderRoster <= picked[i]!.ladderRoster, "smallest ladder first, so the crowd outnumbers its capacity by the most");
  }
  // Control: a crowd no larger than every ladder leaves no refusal control at all,
  // rather than one whose crowd could all win (L63: never "winners equal capacity").
  eq(refusalLadders(CANDIDATES, 16), [], "control: a crowd of sixteen has no ladder smaller than itself");
  const one: LadderCandidate = { code: "900", sibling: "901", rungs: 1, rung0Roster: 0, ladderRoster: 0 };
  eq(refusalLadders([one], 100), [], "a ladder that can book nobody is no control either: nothing would ever win");
}

// --- #3429: the drop burst fires at the shallowest top rung with room below -------
{
  const picked = dropLadders(CANDIDATES, 12, 2, ["500"]);
  assert(picked.length > 0, "the seeded roster has a ladder a drop burst can fire at");
  eq(picked[0]!.code, "120", "120 first: a one deep top rung, three rungs, the lowest code");
  assert(picked.every((c) => c.rung0Roster >= 1), "every drop candidate has somebody on its top rung to take");
  assert(picked.every((c) => c.rungs >= 2), "and a rung below it to drop to");
  assert(picked.every((c) => c.ladderRoster >= 24), "and holds at least twice the crowd");
  assert(!picked.some((c) => c.code === "500"), "and is never the refusal control's own ladder");
  // A ladder of one rung cannot show a drop however deep it is.
  const flat: LadderCandidate = { code: "110", sibling: "111", rungs: 1, rung0Roster: 1, ladderRoster: 74 };
  eq(dropLadders([flat], 12, 2, []), [], "a one rung ladder is never a drop candidate");
  const thin: LadderCandidate = { code: "420", sibling: "421", rungs: 9, rung0Roster: 1, ladderRoster: 19 };
  eq(dropLadders([thin], 12, 2, []), [], "nor one holding less than twice the crowd");
}

// --- #3429: who is free at the slot, from the booker's candidate read per rung ------
{
  eq(ladderFreeFrom([["a"], ["b", "c"], ["c", "d"]]), { rung0Free: 1, ladderFree: 4 }, "the top rung's count and the distinct advisors across every rung");
  eq(ladderFreeFrom([[], ["b"]]), { rung0Free: 0, ladderFree: 1 }, "a top rung with nobody free is zero, the rest still counted");
  eq(ladderFreeFrom([]), { rung0Free: 0, ladderFree: 0 }, "no rungs read, nobody free");
}

{
  const ok = dropSlotFit({ rung0Free: 1, ladderFree: 30 }, 12, 2);
  eq(ok, null, "a slot with one free on top and room for twice the crowd fits");
  const noneOnTop = dropSlotFit({ rung0Free: 0, ladderFree: 30 }, 12, 2);
  assert(noneOnTop !== null && noneOnTop.includes("requested rung"), `a slot with nobody free on the top rung never meets its last advisor (got ${noneOnTop})`);
  const allOnTop = dropSlotFit({ rung0Free: 12, ladderFree: 40 }, 12, 2);
  assert(allOnTop !== null && allOnTop.includes("drop"), `a top rung that holds the whole crowd never needs a drop (got ${allOnTop})`);
  const tight = dropSlotFit({ rung0Free: 1, ladderFree: 23 }, 12, 2);
  assert(tight !== null && tight.includes("23"), `a ladder under twice the crowd is refused, saying how many were free (got ${tight})`);
  eq(dropSlotFit({ rung0Free: 1, ladderFree: 24 }, 12, 2), null, "and exactly twice the crowd is enough");
}

// --- #3429: the plan, one burst per kind in the run's own sequence -------------------
{
  const refusal = {
    codes: ["500", "501"] as [string, string],
    shownTiers: ["high", "high"] as [string | null, string | null],
    slots: ["2026-10-08T15:00:00.000Z", "2026-10-08T19:00:00.000Z"],
    capacities: [
      { ladderRoster: 16, rung0Free: 3, ladderFree: 9 },
      { ladderRoster: 16, rung0Free: 2, ladderFree: 7 },
    ],
  };
  const drop = {
    codes: ["120", "121"] as [string, string],
    shownTiers: ["very_high", null] as [string | null, string | null],
    slot: "2026-10-08T17:00:00.000Z",
    capacity: { ladderRoster: 74, rung0Free: 1, ladderFree: 40 },
  };
  const moments = [1_000, 61_000, 121_000];
  const plan = assembleBurstPlan(["refusal", "drop", "refusal"], moments, refusal, drop);
  eq(plan.bursts.map((b) => b.kind), ["refusal", "drop", "refusal"], "the bursts follow the run's sequence");
  eq(plan.bursts.map((b) => b.startAtMs), moments, "each at its own moment, in order");
  eq(plan.bursts.map((b) => b.slot), [refusal.slots[0], drop.slot, refusal.slots[1]], "the refusal slots fill the refusal bursts in order, the drop slot the drop burst");
  eq(plan.bursts.map((b) => b.codes.join("/")), ["500/501", "120/121", "500/501"], "each burst on its own ladder's two codes");
  eq(plan.bursts.map((b) => b.perDriver), [25, 3, 25], "each with its kind's share");
  eq(plan.bursts[2]!.capacity, refusal.capacities[1], "and the capacity measured at its own slot");
  // #3495: each burst carries the tier its own ladder's two codes had on show.
  eq(plan.bursts.map((b) => b.shownTiers), [refusal.shownTiers, drop.shownTiers, refusal.shownTiers], "each burst carries its own codes' tiers on show (#3495)");
  // The plan it builds is one the drivers read back whole (L41).
  const back = readBurstPlan(JSON.stringify(plan));
  assert(back.ok && JSON.stringify(back.plan) === JSON.stringify(plan), `the drivers read the plan back exactly (got ${JSON.stringify(back)})`);
  let threw = "";
  try {
    assembleBurstPlan(["refusal", "drop", "refusal", "refusal"], [1, 2, 3, 4], refusal, drop);
  } catch (err) {
    threw = String(err);
  }
  assert(threw.includes("refusal"), `a sequence asking for more refusal slots than were chosen is refused, never a burst with no slot (got ${threw})`);
}

// #3529: load run 37838336896 never started. The drop burst's planner measured only the
// 24 furthest offered times, and launched at 4:15 PM ET those were tomorrow's late
// afternoon and evening, with 15 or 16 advisors free against the 24 the burst needs, so
// the run could start only at some hours of the day. The planner walks back far enough
// to reach a working day's middle: at least two working days of 10 minute slots. A working
// day is the org's business hours, seeded 8:00 to 20:00 (migration 0098), so twelve hours.
{
  const TWO_WORKING_DAYS_OF_SLOTS = 2 * 12 * 6;
  assert(
    DROP_SLOTS_TO_MEASURE >= TWO_WORKING_DAYS_OF_SLOTS,
    `the drop burst's planner measures at least ${TWO_WORKING_DAYS_OF_SLOTS} offered times (got ${DROP_SLOTS_TO_MEASURE})`,
  );
}

// #3565: one refusal crowd a run must meet many advisors free across the ladder, the case
// the whole ladder release exists for and the one that failed with 14 free (run
// 37871606406). A slot fits when at least HARD_REFUSAL_MIN_FREE are free across the ladder
// and some of them only below the requested rung; a crowd of 100 is always larger.
{
  eq(hardRefusalFit({ rung0Free: 4, ladderFree: 14 }, HARD_REFUSAL_MIN_FREE), null, "hard refusal: 14 free with 10 below the top rung fits");
  const few = hardRefusalFit({ rung0Free: 2, ladderFree: 3 }, HARD_REFUSAL_MIN_FREE);
  assert(few !== null && few.includes("3 free"), `hard refusal: 3 free across the ladder does not fit, and says how many (got ${few})`);
  const topOnly = hardRefusalFit({ rung0Free: 12, ladderFree: 12 }, HARD_REFUSAL_MIN_FREE);
  assert(topOnly !== null && topOnly.includes("below"), `hard refusal: every free advisor on the requested rung does not fit, since nothing walks (got ${topOnly})`);
  assert(HARD_REFUSAL_MIN_FREE >= 5, `hard refusal: the floor is at least five free (got ${HARD_REFUSAL_MIN_FREE})`);
  // A slot whose free counts were not measured is never judged as if they were (a null read
  // as a number compares false and passes as fitting, or as zero).
  eq(JSON.stringify(measuredFree({ ladderRoster: 16, rung0Free: 4, ladderFree: 14 })), JSON.stringify({ rung0Free: 4, ladderFree: 14 }), "measured: both counts read pass through");
  eq(measuredFree({ ladderRoster: 16, rung0Free: null, ladderFree: 14 }), null, "measured: a missing top rung count is not a measurement");
  eq(measuredFree({ ladderRoster: 16, rung0Free: 4, ladderFree: null }), null, "measured: a missing ladder count is not a measurement");
}

// #3565: the refusal control's choice, every outcome driven through injected reads.
{
  const HOUR = 3_600_000;
  const at = (h: number) => new Date(Date.UTC(2026, 9, 12, h)).toISOString();
  const times = [at(14), at(15), at(16), at(17), at(18)];
  const opts = { bursts: 2, gapMs: HOUR, toMeasure: 72, minFree: HARD_REFUSAL_MIN_FREE };
  const io = (free: Record<string, { rung0Free: number | null; ladderFree: number | null }>, offered: Record<string, string[] | null>) => ({
    offered: async (l: string) => (offered[l] ? { times: offered[l]!, shownTiers: ["ultra_high", "ultra_high"] as [string | null, string | null] } : { why: `${l}: availability did not answer` }),
    free: async (_l: string, t: string) => free[t] ?? { rung0Free: 2, ladderFree: 3 },
    label: (l: string) => l,
  });
  const hardAt16 = { [at(16)]: { rung0Free: 4, ladderFree: 14 } };
  const chosen = await chooseRefusalSlots(["500"], io(hardAt16, { "500": times }), opts);
  assert(chosen.kind === "chosen" && chosen.slots[0] === at(16), `refusal choice: the first crowd takes the time fit for the hard crowd (got ${JSON.stringify(chosen)})`);
  // Run 37960351698's seed offered no slot with ten free on a sixteen advisor ladder, so the
  // hard crowd takes the time with the MOST free across the ladder, over the floor, not the
  // first over it: the hardest crowd the seed offers on every run.
  const most = await chooseRefusalSlots(["500"], io({ [at(18)]: { rung0Free: 2, ladderFree: 6 }, [at(15)]: { rung0Free: 3, ladderFree: 9 }, [at(14)]: { rung0Free: 1, ladderFree: 7 } }, { "500": times }), opts);
  assert(most.kind === "chosen" && most.slots[0] === at(15), `refusal choice: the time with the most free across the ladder is the hard crowd's (got ${JSON.stringify(most)})`);
  assert(chosen.kind === "chosen" && chosen.slots[1] === at(18) && chosen.slots.length === 2, `refusal choice: the other takes the furthest time an hour from it (got ${JSON.stringify(chosen)})`);

  const noHard = await chooseRefusalSlots(["500"], io({}, { "500": times }), opts);
  assert(noHard.kind === "no-hard-slot" && noHard.misses.length === times.length, `refusal choice: no time fit for the hard crowd is its own outcome, naming every miss (got ${JSON.stringify(noHard)})`);

  const unmeasured = await chooseRefusalSlots(["500"], io({ [at(18)]: { rung0Free: null, ladderFree: 14 } }, { "500": [at(18)] }), opts);
  assert(unmeasured.kind === "no-hard-slot" && unmeasured.misses[0]!.includes("not measured"), `refusal choice: an unmeasured slot is a miss that says so, never a fit (got ${JSON.stringify(unmeasured)})`);

  const unanswered = await chooseRefusalSlots(["500", "520"], io(hardAt16, {}), opts);
  assert(unanswered.kind === "unanswered" && unanswered.reads.length === 2, `refusal choice: no ladder answering is the deployment's outcome (got ${JSON.stringify(unanswered)})`);

  const crowded = await chooseRefusalSlots(["500"], io({ [at(16)]: { rung0Free: 4, ladderFree: 14 } }, { "500": [at(16), at(16) ] }), opts);
  assert(crowded.kind === "no-spacing", `refusal choice: a hard time with nothing an hour from it is a spacing outcome, never blamed on the hard crowd (got ${JSON.stringify(crowded)})`);

  const second = await chooseRefusalSlots(["500", "520"], io(hardAt16, { "500": [at(14)], "520": times }), opts);
  assert(second.kind === "chosen" && second.ladder === "520", `refusal choice: a ladder with nothing fit gives way to the next (got ${JSON.stringify(second)})`);
}

finish();
