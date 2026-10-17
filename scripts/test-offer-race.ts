// A time refused at the cached free check: a LOST RACE, or a stale offer (#3797)?
//
// On 2026-10-16 the booking failure page fired at 12:35am ET on seven refusals, and six
// were ordinary lost races: the time was free when the lead's list was computed, and
// another booking took the last free advisor before the confirm. Dan, 2026-10-16: a
// PROVEN race is counted apart and does not page; only a time offered when it was
// never free pages, and unknown is never folded into race. This drives the judge, the
// real createBooking around it, the tally predicate the routes share, and a replay of
// the seven refusals of that night.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-offer-race.ts
import { readFileSync } from "node:fs";
import {
  judgeOfferRace,
  newestProofMs,
  OFFER_RACE_OUTCOME,
  OFFER_VERDICTS,
  type BlockingWrite,
} from "../src/lib/booking/offer-race.ts";
import { provenOfferRace, refusalTraceOf, refusalLogFields } from "../src/lib/booking/refusal-trace.ts";
import { createBooking, SlotUnavailableError, type CreateBookingInput } from "../src/lib/booking/orchestration.ts";
import { OUTCOME_ORDER, normalizeMix } from "../src/lib/monitor/booking-api-outcome.ts";
import { countRefusedPeople } from "../src/lib/monitor/booking-failure-rate.ts";
import { input, makeDeps } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SERVED = "2026-10-16T02:00:07.526Z";
const block = (userId: string, createdAt: string, source = "slate"): BlockingWrite => ({ userId, createdAt, source });

async function main() {
  // --- The judge ------------------------------------------------------------------

  // Done when 1: the blocking write is newer than the served computed_at, so a race.
  {
    const j = judgeOfferRace({
      servedComputedAt: SERVED,
      memberIds: ["a", "b"],
      blocks: [block("a", "2026-10-15T20:00:00.000Z", "gcal"), block("b", "2026-10-16T02:02:31.982Z", "gcal")],
      provenStaleAtMs: null,
    });
    eq(j.verdict, "race", "an advisor free when the list was computed and taken since is a race");
    eq(j.takenUserIds, ["b"], "and it names who was taken");
  }
  // Done when 2b: only older writes, so the list was wrong when it was computed.
  {
    const j = judgeOfferRace({
      servedComputedAt: SERVED,
      memberIds: ["a", "b"],
      blocks: [block("a", "2026-10-15T20:00:00.000Z"), block("b", "2026-10-16T01:59:00.000Z")],
      provenStaleAtMs: null,
    });
    eq(j.verdict, "stale_offer", "only writes older than the list is a stale offer");
  }
  // An advisor busy before the list AND again after was never free for it.
  {
    const j = judgeOfferRace({
      servedComputedAt: SERVED,
      memberIds: ["a"],
      blocks: [block("a", "2026-10-16T01:00:00.000Z"), block("a", "2026-10-16T02:01:00.000Z")],
      provenStaleAtMs: null,
    });
    eq(j.verdict, "stale_offer", "an advisor with an older block too was never free, whatever was added since");
  }
  // Unknown is never folded into race.
  {
    eq(
      judgeOfferRace({ servedComputedAt: "not a time", memberIds: ["a"], blocks: [block("a", "2026-10-16T02:01:00Z")], provenStaleAtMs: null }).verdict,
      "unknown",
      "an unreadable served stamp is unknown, never a race",
    );
    eq(
      judgeOfferRace({ servedComputedAt: SERVED, memberIds: ["a"], blocks: [block("a", "garbage"), block("a", "2026-10-16T02:01:00Z")], provenStaleAtMs: null }).verdict,
      "stale_offer",
      "a block whose stamp cannot be read counts as old, so it can only stop a race",
    );
    eq(
      judgeOfferRace({ servedComputedAt: SERVED, memberIds: ["a"], blocks: [block("a", "2026-10-16T02:01:00Z", "hold")], provenStaleAtMs: null }).verdict,
      "stale_offer",
      "a hold block is left out, as the candidate read leaves it out",
    );
    eq(
      judgeOfferRace({ servedComputedAt: SERVED, memberIds: ["a"], blocks: [block("zz", "2026-10-16T02:01:00Z")], provenStaleAtMs: null }).verdict,
      "stale_offer",
      "a block on somebody outside the pools proves nothing",
    );
  }
  // The 2026-10-16 comment: a second refusal on a row proven stale seconds earlier,
  // whose blocking write is newer than its computed_at, is a stale offer.
  {
    const proof = newestProofMs([{ createdAt: "2026-10-16T02:02:32.422Z" }, { createdAt: "2026-10-16T01:00:00Z" }, { createdAt: "bad" }]);
    eq(proof, Date.parse("2026-10-16T02:02:32.422Z"), "the newest readable proof is the one judged against");
    const j = judgeOfferRace({
      servedComputedAt: SERVED,
      memberIds: ["a"],
      blocks: [block("a", "2026-10-16T02:02:31.982Z", "gcal")],
      provenStaleAtMs: proof,
    });
    eq(j.verdict, "stale_offer", "a list older than a proof that its row was stale is a stale offer, whatever the write's time");
    eq(j.reason, "row_proven_stale", "and says why");
    eq(
      judgeOfferRace({ servedComputedAt: "2026-10-16T02:24:08.327Z", memberIds: ["a"], blocks: [block("a", "2026-10-16T02:25:36Z")], provenStaleAtMs: proof }).verdict,
      "race",
      "a list computed after the proof is judged on its own writes",
    );
  }

  // --- The vocabulary the migration holds ----------------------------------------
  {
    const sql = readFileSync(new URL("../supabase/migrations/0186_routing_offer_race.sql", import.meta.url), "utf8");
    const check = /offer_verdict in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    eq(check.split(",").map((v) => v.trim().replace(/'/g, "")), [...OFFER_VERDICTS], "the column's check holds exactly the code's verdicts");
    assert(!(OUTCOME_ORDER as readonly string[]).includes(OFFER_RACE_OUTCOME), "the race outcome is outside OUTCOME_ORDER, so outside the failure share");
    const mix = normalizeMix({ by_outcome: { created: 27, error: 1, [OFFER_RACE_OUTCOME]: 6 }, by_error: { slot_unavailable: 1 } });
    eq([mix.total, mix.lostRacesSinceOffer], [28, 6], "a mix counts the races apart: in neither the attempts nor the failures");
  }

  // --- The tally predicate both routes share --------------------------------------
  {
    const withVerdict = (v?: "race" | "stale_offer" | "unknown") => {
      const err = new SlotUnavailableError();
      (err as unknown as Record<symbol, unknown>)[Symbol.for("slate.refusalTrace")] = {
        requestedStart: null,
        bucketCode: "112",
        stage: "candidate_read_empty",
        rungs: [],
        ...(v ? { offerVerdict: v } : {}),
      };
      return err;
    };
    assert(provenOfferRace(withVerdict("race")), "a proven race is tallied apart");
    assert(!provenOfferRace(withVerdict("stale_offer")), "a stale offer is the error it always was");
    assert(!provenOfferRace(withVerdict("unknown")), "unknown is the error it always was, never a race");
    assert(!provenOfferRace(withVerdict()), "a refusal never judged (no computed_at) is the error it always was");
    assert(!provenOfferRace(new Error("plain")), "an error with no trace is never a race");
    eq(refusalLogFields(refusalTraceOf(withVerdict("race"))!).offer_verdict, "race", "the confirm line says the verdict");
  }

  // --- The people count ---------------------------------------------------------
  {
    const r = countRefusedPeople([
      { lead_id: "00QUi000011bFqE", is_test: false, offer_verdict: "race" },
      { lead_id: "00QUi00000pZ0xR", is_test: false, offer_verdict: "race" },
      { lead_id: "00QUi000011b66z", is_test: false, offer_verdict: "stale_offer" },
      { lead_id: "00QUi000011b5Sf", is_test: false, offer_verdict: null },
    ]);
    eq(r, { people: 2, refusals: 2, withoutLead: 0, races: 2 }, "a proven race is outside the people count and the refusals, counted apart");
  }

  // --- Through the real createBooking --------------------------------------------
  const LEAD = "00QUi00000zhEUPMA2";
  const refused: CreateBookingInput = { ...input, salesforceId: LEAD, servedComputedAt: SERVED };
  const refuse = async (deps: ReturnType<typeof makeDeps>["deps"], inp: CreateBookingInput) => {
    try {
      await createBooking(inp, deps);
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  };
  const withMembers = (made: ReturnType<typeof makeDeps>) => {
    const inner = made.deps.roundRobinCandidates;
    made.deps.roundRobinCandidates = async (...args) => ({ ...(await inner(...args)), memberIds: ["a", "b", "c"] });
    return made;
  };
  {
    const made = withMembers(makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] }));
    const asked: { served: string | null; members: string[] }[] = [];
    made.deps.judgeRefusedOffer = async ({ trace, servedComputedAt }) => {
      asked.push({ served: servedComputedAt, members: [...new Set(trace.rungs.flatMap((r) => r.memberIds ?? []))] });
      return { verdict: "race", staleRowCodes: [] };
    };
    const err = await refuse(made.deps, refused);
    assert(err instanceof SlotUnavailableError, "the lead is still told the time is taken");
    eq(asked, [{ served: SERVED, members: ["a", "b", "c"] }], "the judge is asked once, with the served stamp and every rung's advisors");
    assert(provenOfferRace(err), "the refusal carries the race verdict the route tallies apart");
    const row = made.calls.recordRoutingDecision[0];
    eq([row?.offerVerdict, row?.servedComputedAt], ["race", SERVED], "the routing decision records the verdict and the stamp");
  }
  {
    // Done when 2a: no computed_at sent, so nothing is judged a race.
    const made = withMembers(makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] }));
    let served: string | null | undefined;
    made.deps.judgeRefusedOffer = async ({ servedComputedAt }) => {
      served = servedComputedAt;
      return { verdict: null, staleRowCodes: ["411"] };
    };
    const err = await refuse(made.deps, { ...refused, servedComputedAt: undefined });
    eq(served, null, "a confirm with no computed_at is judged with none");
    assert(!provenOfferRace(err), "and stays a stale offer for the tally");
    const row = made.calls.recordRoutingDecision[0];
    eq([row?.offerVerdict ?? null, row?.staleRowCodes], [null, ["411"]], "it records no verdict, and still leaves its row proof");
  }
  {
    // A judge that fails is unknown, the refusal is still recorded, and nothing is a race.
    const made = withMembers(makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] }));
    made.deps.judgeRefusedOffer = async () => {
      throw new Error("busy_blocks read timed out");
    };
    const err = await refuse(made.deps, refused);
    assert(err instanceof SlotUnavailableError, "a failed judgement never changes the refusal");
    eq(made.calls.recordRoutingDecision[0]?.offerVerdict, "unknown", "it is recorded as unknown");
    assert(!provenOfferRace(err), "and is never tallied as a race");
  }
  {
    // The stamp is the client's own string and `served_computed_at` is a timestamptz,
    // so one that is not a time must never reach the column: a refused insert loses
    // the whole routing decision. It is stored only once read, and then as an instant.
    const made = withMembers(makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] }));
    made.deps.judgeRefusedOffer = async () => ({ verdict: "unknown", staleRowCodes: [] });
    await refuse(made.deps, { ...refused, servedComputedAt: "not a time" });
    const row = made.calls.recordRoutingDecision[0];
    eq([row?.offerVerdict, row?.servedComputedAt], ["unknown", null], "an unreadable stamp is recorded as unknown with no stamp stored");

    const again = withMembers(makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] }));
    again.deps.judgeRefusedOffer = async () => ({ verdict: "race", staleRowCodes: [] });
    await refuse(again.deps, { ...refused, servedComputedAt: "2026-10-16T02:00:07.526+00:00" });
    eq(again.calls.recordRoutingDecision[0]?.servedComputedAt, "2026-10-16T02:00:07.526Z", "a readable one is stored as the instant it names");
  }
  {
    // A refusal Google made is not this check's to judge.
    const made = withMembers(makeDeps({ candidates: ["a", "b"], freeEmails: new Set(), poolAgents: ["a", "b", "c"] }));
    let asked = 0;
    made.deps.judgeRefusedOffer = async () => {
      asked += 1;
      return { verdict: "race", staleRowCodes: [] };
    };
    const err = await refuse(made.deps, refused);
    eq(refusalTraceOf(err)?.stage, "verify_busy", "Google found everyone busy");
    eq(asked, 0, "a verify_busy refusal is never judged");
    assert(!provenOfferRace(err), "and is never tallied as a race");
  }

  // --- The replay: the seven refusals of 2026-10-15/16 ------------------------------
  {
    const fx = JSON.parse(readFileSync(new URL("./fixtures/offer-races-2026-10-15.json", import.meta.url), "utf8")) as {
      refusals: {
        refusedAt: string;
        codes: string[];
        servedComputedAt: string;
        staleRowCodes: string[];
        members: string[];
        blocks: { member: string; createdAt: string; source: string }[];
      }[];
    };
    eq(fx.refusals.length, 7, "the fixture holds the night's seven refusals");
    const verdicts: string[] = [];
    fx.refusals.forEach((r, i) => {
      // The proofs a refusal sees: earlier refusals on its codes, made after its list
      // was computed, whose stored row still offered their time (the live query).
      const proofs = fx.refusals
        .slice(0, i)
        .filter((p) => p.staleRowCodes.some((c) => r.codes.includes(c)) && Date.parse(p.refusedAt) > Date.parse(r.servedComputedAt))
        .map((p) => ({ createdAt: p.refusedAt }));
      verdicts.push(
        judgeOfferRace({
          servedComputedAt: r.servedComputedAt,
          memberIds: r.members,
          blocks: r.blocks.map((b) => ({ userId: b.member, createdAt: b.createdAt, source: b.source })),
          provenStaleAtMs: newestProofMs(proofs),
        }).verdict,
      );
    });
    eq(verdicts, ["race", "race", "stale_offer", "race", "race", "race", "race"], "six races and one stale offer, the 10:02:45pm reload");
  }

  finish();
}

await main();
