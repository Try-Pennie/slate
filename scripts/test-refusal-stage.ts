// A refused confirm records when it asked for, which stage refused it, and who (#3272).
//
// On 2026-10-04 twenty three confirms were refused in seventy five minutes and not
// one could be traced to the instant its lead picked. This drives each refusal stage
// through the real createBooking and asserts what the routing decision row records
// (the instant, the stage, the per rung counts, the lead) and what the confirm line
// says, and pins the excluded list, which used to mark every eligible advisor
// no_availability whatever refused them.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-refusal-stage.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBooking,
  NoEligibleAgentsError,
  RaceLostRefusalError,
  SlotUnavailableError,
  VerifyUnavailableError,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import {
  ladderStage,
  RECORDED_REFUSAL_STAGES,
  REFUSAL_STAGES,
  refusalLogFields,
  refusalTraceOf,
  refusedLeadId,
  rungStage,
} from "../src/lib/booking/refusal-trace.ts";
import { answerTimed, noteRefusal, type ConfirmLineFacts } from "../src/lib/booking/confirm-latency.ts";
import { createAsserter, input, makeDeps } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const HERE = dirname(fileURLToPath(import.meta.url));

// A real looking 18 character lead id; the record keeps its 15 character key.
const LEAD = "00QUi00000zhEUPMA2";
const refusedInput: CreateBookingInput = { ...input, salesforceId: LEAD };

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

async function main() {
  // --- candidate read empty: people exist, the cache found none free ------------
  {
    const { deps, calls } = makeDeps({ candidates: [], memberCount: 3, poolAgents: ["a", "b", "c"] });
    const err = await refusal(() => createBooking(refusedInput, deps));
    assert(err instanceof SlotUnavailableError, "read empty: refused as taken");
    const row = calls.recordRoutingDecision[0];
    assert(calls.recordRoutingDecision.length === 1, "read empty: one routing decision");
    assert(row?.refusalStage === "candidate_read_empty", `read empty: the stage (got ${row?.refusalStage})`);
    assert(row?.requestedStart === refusedInput.startIso, `read empty: the instant asked for (got ${row?.requestedStart})`);
    assert(row?.bucketCode === "411", "read empty: the bucket tried");
    const first = row?.stageCounts?.[0];
    assert(
      first?.code === "411" && first.members === 3 && first.read === 0 && first.checked === 0,
      `read empty: the requested rung's counts (got ${JSON.stringify(first)})`,
    );
    assert(calls.verifyFree.length === 0, "read empty: nothing was asked of Google");
    assert(row?.leadId === LEAD.slice(0, 15), `read empty: the lead, 15 character key (got ${row?.leadId})`);
    // Nobody was free in the cache, so every eligible advisor really was unavailable.
    assert(
      row?.excluded.length === 3 && row.excluded.every((e) => e.reason === "no_availability") && row.considered.length === 0,
      `read empty: the whole pool unavailable in the cache (got ${JSON.stringify(row?.excluded)})`,
    );
  }

  // --- Google found everyone busy: the read free advisors are NOT no_availability --
  {
    const { deps, calls } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(), poolAgents: ["a", "b", "c"] });
    const err = await refusal(() => createBooking(refusedInput, deps));
    assert(err instanceof SlotUnavailableError && !(err instanceof RaceLostRefusalError), "busy: refused as taken");
    const row = calls.recordRoutingDecision[0];
    assert(row?.refusalStage === "verify_busy", `busy: the stage (got ${row?.refusalStage})`);
    const first = row?.stageCounts?.[0];
    assert(
      first?.code === "411" && first.members === 2 && first.read === 2 && first.checked === 2 && first.stage === "verify_busy",
      `busy: read two, sent two to Google (got ${JSON.stringify(first)})`,
    );
    // The fix: the two the cache read as free were considered and refused by Google;
    // only c was unavailable in the cache. An empty free set used to mark all three.
    assert(
      JSON.stringify(row?.considered) === JSON.stringify(["a", "b"]),
      `busy: the cache's free set is what was considered (got ${JSON.stringify(row?.considered)})`,
    );
    assert(
      row?.excluded.length === 1 && row.excluded[0].user_id === "c" && row.excluded[0].reason === "no_availability",
      `busy: only the advisor the cache had busy is no_availability (got ${JSON.stringify(row?.excluded)})`,
    );
  }

  // --- Google could not answer: verify unreadable -------------------------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]),
    });
    const err = await refusal(() => createBooking(refusedInput, deps));
    assert(err instanceof VerifyUnavailableError, "unreadable: the retryable outage");
    const row = calls.recordRoutingDecision[0];
    assert(row?.refusalStage === "verify_unreadable", `unreadable: the stage (got ${row?.refusalStage})`);
    assert(row?.requestedStart === refusedInput.startIso, "unreadable: the instant");
  }

  // --- an empty pool ------------------------------------------------------------
  {
    const { deps, calls } = makeDeps({ candidates: [], memberCount: 0, poolAgents: [] });
    const err = await refusal(() => createBooking(refusedInput, deps));
    assert(err instanceof NoEligibleAgentsError, "pool empty: no eligible agents");
    const row = calls.recordRoutingDecision[0];
    assert(row?.outcome === "no_eligible_agents", "pool empty: the outcome it always had");
    assert(row?.refusalStage === "pool_empty", `pool empty: the stage (got ${row?.refusalStage})`);
    assert(row?.stageCounts?.[0]?.members === 0, "pool empty: zero members on the requested rung");
  }

  // --- a lost race: the refusal that used to write no row at all -----------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const err = await refusal(() => createBooking(refusedInput, deps));
    assert(err instanceof RaceLostRefusalError, "race: refused as a lost race");
    const rows = calls.recordRoutingDecision.filter((r) => r.outcome === "no_availability");
    assert(rows.length === 1, `race: one refusal row (got ${rows.length})`);
    assert(rows[0]?.refusalStage === "race_lost", `race: the stage (got ${rows[0]?.refusalStage})`);
    assert(rows[0]?.requestedStart === refusedInput.startIso, "race: the instant");
    assert(rows[0]?.leadId === LEAD.slice(0, 15), "race: the lead");
    const t = refusalTraceOf(err);
    assert(t?.stage === "race_lost" && t.lostRaces === 1, `race: the trace (got ${JSON.stringify(t)})`);
  }

  // --- a booked confirm records none of it ---------------------------------------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(refusedInput, deps);
    const row = calls.recordRoutingDecision[0];
    assert(row?.outcome === "booked", "booked: control");
    assert(
      row?.requestedStart === undefined && row?.refusalStage === undefined && row?.leadId === undefined,
      "booked: no refusal columns on a booking",
    );
  }

  // --- the confirm line says the same, from the error the route turns into a 409 --
  {
    const { deps } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(), poolAgents: ["a", "b"] });
    const err = await refusal(() => createBooking(refusedInput, deps));
    const facts: ConfirmLineFacts = {};
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await answerTimed(
        "booking",
        async () => {
          noteRefusal(facts, err);
          return new Response("{}", { status: 409 });
        },
        { now: () => 0, facts },
      );
    } finally {
      console.info = original;
    }
    const line = lines.find((l) => l.includes('msg="confirm answered"')) ?? "";
    // The fake answers every rung of the ladder with the same 411 pool, so the
    // ladder reads as three rungs of 411, each read two and sent two to Google.
    for (const want of [
      'refusal_stage="verify_busy"',
      `requested_start="${refusedInput.startIso}"`,
      'bucket_code="411"',
      'stage_counts="411:2/2/0/2,411:2/2/0/2,411:2/2/0/2"',
      `lead_id="${LEAD.slice(0, 15)}"`,
      "status=409",
    ]) {
      assert(line.includes(want), `line: carries ${want} (got ${line})`);
    }
    const plain: ConfirmLineFacts = {};
    noteRefusal(plain, new Error("unrelated"));
    assert(plain.refusal === undefined, "line: an error with no trace adds nothing");
  }

  // --- the pure rules -----------------------------------------------------------
  assert(rungStage({ members: 0, read: 0, anyUnverified: false }) === "pool_empty", "rung: no members");
  assert(rungStage({ members: 4, read: 0, anyUnverified: false }) === "candidate_read_empty", "rung: none read");
  assert(rungStage({ members: 4, read: 2, anyUnverified: false }) === "verify_busy", "rung: Google busy");
  assert(rungStage({ members: 4, read: 2, anyUnverified: true }) === "verify_unreadable", "rung: Google unreadable");
  const r = (stage: "pool_empty" | "candidate_read_empty" | "verify_busy") => ({
    code: "x",
    members: 1,
    read: 1,
    claimed: 0,
    checked: 1,
    stage,
  });
  // 12235b51: three rungs, Google refused all of them; an empty fourth rung must not
  // turn that into "the cache had nobody".
  assert(
    ladderStage([r("verify_busy"), r("verify_busy"), r("verify_busy"), r("candidate_read_empty")]) === "verify_busy",
    "ladder: the furthest stage any rung reached",
  );
  assert(ladderStage([]) === "pool_empty", "ladder: no rung reached is an empty pool");
  assert(refusedLeadId({ salesforceId: "sf1", externalId: LEAD }) === LEAD.slice(0, 15), "lead: an external id that is a lead id");
  assert(refusedLeadId({ salesforceId: "sf1", externalId: "ext-9" }) === null, "lead: no lead id named is null, not a guess");
  const fields = refusalLogFields({ requestedStart: null, bucketCode: null, stage: "follower", rungs: [], leaderRefusal: "taken" });
  assert(fields.refusal_stage === "follower" && fields.leader_refusal === "taken" && !("stage_counts" in fields), "fields: a follower");

  // --- the stored vocabulary is the code's --------------------------------------
  const sql = readFileSync(join(HERE, "..", "supabase", "migrations", "0168_routing_refusal_stage.sql"), "utf8");
  const check = /refusal_stage in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
  const inSql = [...check.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  assert(
    JSON.stringify(inSql) === JSON.stringify([...RECORDED_REFUSAL_STAGES].sort()),
    `vocabulary: the migration's check is exactly the recorded stages (got ${JSON.stringify(inSql)})`,
  );
  assert(
    REFUSAL_STAGES.length === RECORDED_REFUSAL_STAGES.length + 1 && !RECORDED_REFUSAL_STAGES.includes("follower" as never),
    "vocabulary: only the follower stays off the row",
  );
}

main()
  .then(finish)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
