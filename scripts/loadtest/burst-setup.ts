// Picks the burst plan every burst driver fires (#2262, #3325): the code and its
// sibling, and for each of the run's three bursts ONE slot and ONE moment, and writes
// it where the workflow's matrix can read it.
//
// THREE bursts (#3325), each at its own slot and moment and each judged on its own,
// because one burst is one spread of requests over the deployment's isolates and one
// lucky spread can pass a run a second would fail (L395). The slots are an hour apart
// so no burst's bookings overlap another's slot, and the moments are spaced past one
// burst's longest life so no two bursts overlap in time.
//
// Split across TWO codes (#3325) whose fallback ladders are the same pools at every
// rung, MEASURED from the branch's own bucket rows through the booker's ladder and the
// recompute lane's pool key. The shared confirm line keys a crowd on the whole ladder,
// so the split is what proves the line ACROSS codes rather than only within one. A
// roster with no such pair is refused on its own exit code rather than burst on one
// code, because a burst that cannot exercise the line across codes is not the control.
//
// The BUCKET is measured now rather than assumed (#2278). The whole burst control
// rests on its pool being one agent deep, and that was a hand maintained constant
// nothing checked: the seeded roster gave it three, so a live run answered three
// 200s on three different agents, which is correct behaviour and a materially
// weaker control than the one intended. The constant rots too, and did, when
// production's Low plus Beyond pool emptied (#2152) and it had to be moved by hand
// the morning of the next run (#2319). So every pool's depth is read through the
// booker's own predicate, the shallowest that is actually OFFERING times is
// chosen, and the depth it ran at is handed to the judge to report.
//
// It never refuses on depth. The judge asks one winner per AGENT (#2273), which
// holds at any depth, so a run red because the roster has no one deep pool would
// be red for a property of the roster (L36). What it refuses is a depth it could
// not READ, because an unmeasured depth that renders as a number is the exact
// failure this fixes.
//
// It exists because a burst whose drivers each chose their own slot and their own
// moment is not a burst: nothing contends, everything succeeds, and the control it
// is there to be ("exactly one 200 against a pool of one, every other answer
// SLOT_TAKEN") is satisfied by a run that never tested anything.
//
// Finding nothing to burst at is NEVER a pass (L98). Every way of learning nothing
// exits non-zero with the reason, because the alternative is a burst leg that
// produced an empty file and a judge that reads it as a run with no burst.
//
// Run:
//   SLATE_BASE=https://<loadtest>.workers.dev BURST_LEAD_SECONDS=300 \
//   node --experimental-strip-types scripts/loadtest/burst-setup.ts
import { appendFileSync } from "node:fs";
import {
  chooseBurstSlots,
  burstStartAt,
  burstMoments,
  offeredSlots,
  DRIVERS,
  BURST_LEGS,
  BURST_SLOT_GAP_MS,
  BURST_SPACING_MS,
  type BurstPlan,
} from "./book-plan.ts";
import { burstPairOrder, poolKeysByCode, type BurstDepthReading } from "./burst-target.ts";
import { poolDepthsFrom } from "./pool-depth.ts";
import { PRODUCTION_SUPABASE_REF, PRODUCTION_HOST } from "../../src/lib/loadtest-guard.ts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { listPoolBuckets } from "@/lib/availability/precompute";
import type { Attributes } from "@/lib/db/types";

const PROD_HOSTS = [PRODUCTION_HOST, `${PRODUCTION_SUPABASE_REF}.supabase.co`];

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was chosen.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
// env-ok: BURST_CODE_OVERRIDE (optional; only a deliberate experiment, or a hand
// run with no database credentials, would name the code instead of measuring it)
const CODE_OVERRIDE = (process.env.BURST_CODE_OVERRIDE ?? "").trim() || null;
// env-ok: BURST_SIBLING_OVERRIDE (optional; required beside BURST_CODE_OVERRIDE, the
// second code a hand named burst is split across, unmeasured like the code itself)
const SIBLING_OVERRIDE = (process.env.BURST_SIBLING_OVERRIDE ?? "").trim() || null;

/**
 * How many code pairs are asked what they are offering.
 *
 * `/api/availability` has its own per address ceiling (30 a minute) and this job
 * shares that address with everything else it does, so the walk down the depth
 * ordering is bounded rather than running the whole 60 code matrix. Each pair is two
 * reads (#3325), so six pairs is at most twelve, inside the ceiling; in practice the
 * first pair answers.
 */
const CANDIDATES_TO_ASK = 6;
// env-ok: BURST_LEAD_SECONDS (optional; defaults to 300, which has to cover a
// runner being queued, checked out and installed)
const LEAD = Number((process.env.BURST_LEAD_SECONDS ?? "300").trim());

for (const host of PROD_HOSTS) {
  if (SLATE_BASE.includes(host)) {
    console.error(`FAILED: SLATE_BASE points at production (${host}).`);
    process.exit(1);
  }
}
if (CODE_OVERRIDE && (!SIBLING_OVERRIDE || SIBLING_OVERRIDE === CODE_OVERRIDE)) {
  // Refused by name. A burst on one code never exercises the shared line ACROSS
  // codes, and quietly firing one would hand the judge a control that cannot prove
  // what it is there to prove (#3325).
  console.error(
    "FAILED: BURST_CODE_OVERRIDE names the code by hand, so BURST_SIBLING_OVERRIDE must name a " +
      "DIFFERENT second code to split each burst across.",
  );
  process.exit(1);
}
if (!Number.isFinite(LEAD) || LEAD <= 0) {
  // Refused by name rather than left as NaN: `burstStartAt` would clamp a NaN lead
  // to now, every driver would wake late, and the run would report a burst nobody
  // attended with the reason being a typo nothing named (L50).
  console.error(`FAILED: BURST_LEAD_SECONDS is not a positive number of seconds.`);
  process.exit(1);
}

/** What one code is offering, or null when the deployment would not answer for it. */
async function offeredFor(code: string): Promise<string[] | null> {
  const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${code}`);
  if (!res.ok) return null;
  // Through the shared reader (#2261), which THROWS on a payload it cannot read
  // rather than resolving to an empty list: an unreadable shape would otherwise
  // arrive here as "this bucket offers nothing" and refuse the run for the wrong
  // reason entirely.
  return offeredSlots(await res.json());
}

// The pools, measured. A code named by hand skips the measurement and says so, so
// a hand run with no database credentials is still possible and is never mistaken
// for a measured one deep pool.
let candidates: { code: string; sibling: string }[];
let depthByCode = new Map<string, number>();
if (CODE_OVERRIDE && SIBLING_OVERRIDE) {
  candidates = [{ code: CODE_OVERRIDE, sibling: SIBLING_OVERRIDE }];
} else {
  let depths;
  let poolKeys;
  try {
    const db = supabaseAdmin();
    // cap-safe: users is roster bounded, the seeded roster is ~94 rows against a
    // 200-agent design target
    const agents = (unwrap(
      await db
        .from("users")
        .select("id, attributes")
        .eq("bookable", true)
        .is("deactivated_at", null)
        .eq("is_test", false),
      "burst target agents",
    ) ?? []) as { id: string; attributes: Attributes | null }[];
    // The buckets and their hand named members through the app's OWN pool reader
    // (#3325), the one the recompute lane groups on, so the depths and the ladders
    // below are read from exactly the inputs the booker uses (L107). Test buckets are
    // left out, as they always were here.
    const rows = (await listPoolBuckets()).filter((r) => !r.bucket.is_test);
    depths = poolDepthsFrom({
      agents,
      buckets: rows.map((r) => ({ id: r.bucket.id, code: r.code, criteria: r.criteria })),
      members: rows.flatMap((r) => r.memberIds.map((user_id) => ({ bucket_id: r.bucket.id, user_id }))),
    });
    poolKeys = poolKeysByCode(rows);
  } catch (err) {
    // Its OWN exit code. A roster this cannot read and a roster with nothing to
    // burst at send two different people to two different places (L11), and an
    // empty depth list would make every pool look unreachable and pick nothing.
    console.error(
      `FAILED: the pools could not be measured (${String(err)}), so the burst has no way to know ` +
        `how deep the pool it fires at is. Set the database credentials, or name the codes with ` +
        `BURST_CODE_OVERRIDE and BURST_SIBLING_OVERRIDE and accept an unmeasured control.`,
    );
    process.exit(4);
  }
  depthByCode = new Map(depths.map((d) => [d.code, d.depth]));
  if (!depths.some((d) => d.depth > 0)) {
    console.error(
      `FAILED: not one of the ${depths.length} pools has an agent in it, so there is nothing to ` +
        `burst at. The seed did not staff the roster.`,
    );
    process.exit(5);
  }
  candidates = burstPairOrder(depths, poolKeys, CANDIDATES_TO_ASK);
  if (candidates.length === 0) {
    // Its own code (#3325): the roster has agents, and no two codes share a fallback
    // ladder, so a burst cannot be split across codes the shared line treats as one.
    // That is a property of the bucket rows, never the deployment, and firing on one
    // code instead would hand the judge a control that cannot prove the split.
    console.error(
      `FAILED: no staffed code shares its whole fallback ladder with another code on this branch, ` +
        `so the burst cannot be split across two codes of one line. Two codes qualify when every ` +
        `rung of their ladders resolves to the same pool (criteria, members, fallback advisor, event ` +
        `type); a hand named member or a fallback advisor on one bucket splits it from its siblings.`,
    );
    process.exit(6);
  }
  console.log(
    `pools measured: asking ${candidates.map((c) => `${c.code} with ${c.sibling} (${depthByCode.get(c.code)} deep)`).join(", ")}`,
  );
}

// Walk the candidates shallowest first and fire at the first pair offering THREE
// times an hour apart that BOTH codes offer. A pool one agent deep whose one agent has
// no free time offers nothing, so depth alone cannot choose; and each sibling is asked
// too, because a time only one of the two offers would be refused for the other half
// of the burst for a reason that is not contention.
let CODE: string | null = null;
let SIBLING: string | null = null;
let slots: string[] | null = null;
let offeredCount = 0;
const readFailures: string[] = [];
for (const pair of candidates) {
  let offered: string[] | null;
  let siblingOffered: string[] | null;
  try {
    offered = await offeredFor(pair.code);
    siblingOffered = offered === null ? null : await offeredFor(pair.sibling);
  } catch (err) {
    readFailures.push(`${pair.code}/${pair.sibling}: ${String(err)}`);
    continue;
  }
  if (offered === null || siblingOffered === null) {
    readFailures.push(`${pair.code}/${pair.sibling}: availability did not answer`);
    continue;
  }
  const both = new Set(siblingOffered);
  const shared = offered.filter((t) => both.has(t));
  const chosen = chooseBurstSlots(shared, BURST_LEGS, BURST_SLOT_GAP_MS);
  if (chosen !== null) {
    CODE = pair.code;
    SIBLING = pair.sibling;
    slots = chosen;
    offeredCount = shared.length;
    break;
  }
}
if (CODE === null || SIBLING === null || slots === null) {
  // TWO exit codes, because a bucket offering nothing and an availability read
  // that failed send two different people to two different places (L11): the
  // first is a seed or a roster problem, the second is the deployment. The walk
  // over several candidates is what makes the distinction worth drawing at the
  // END rather than on the first bad read: one unreadable code among six that
  // answered is not the deployment being down.
  const asked = candidates.map((c) => `${c.code}/${c.sibling}`).join(", ");
  if (readFailures.length === candidates.length) {
    console.error(
      `FAILED: availability answered for none of ${asked}, so no slot could be ` +
        `chosen and nothing is known about any pool. Reads: ${readFailures.join("; ")}.`,
    );
    process.exit(2);
  }
  console.error(
    `FAILED: none of ${asked} offered ${BURST_LEGS} times at least ${BURST_SLOT_GAP_MS / 60_000} ` +
      `minutes apart that both codes of the pair offer, so there is nothing to burst at. The burst ` +
      `aims at the shallowest pools, so an empty answer here usually means the seed did not staff ` +
      `them.${readFailures.length > 0 ? ` Reads that did not answer: ${readFailures.join("; ")}.` : ""}`,
  );
  process.exit(3);
}

// What the report will say this control actually proved. An override skips the
// measurement, and that reads as unmeasured rather than as a depth (L98).
const depth = depthByCode.get(CODE);
const reading: BurstDepthReading =
  depth === undefined
    ? {
        measured: false,
        code: CODE,
        why: "the codes were named by BURST_CODE_OVERRIDE and BURST_SIBLING_OVERRIDE rather than measured",
      }
    : { measured: true, code: CODE, depth };

const startAt = burstStartAt(Date.now(), LEAD);
const moments = burstMoments(startAt, BURST_LEGS, BURST_SPACING_MS);
const plan: BurstPlan = {
  codes: [CODE, SIBLING],
  bursts: slots.map((slot, i) => ({ slot, startAtMs: moments[i]! })),
};
console.log(`burst: bucket ${CODE} split with ${SIBLING}, ${plan.bursts.length} bursts`);
for (const [i, b] of plan.bursts.entries()) {
  console.log(`  burst ${i + 1}: slot ${b.slot}, firing at ${new Date(b.startAtMs).toISOString()}`);
}
console.log(`  (chosen from ${offeredCount} times both codes offered, the first ${Math.round(LEAD)}s from now)`);
console.log(`  (${reading.measured ? `pool ${reading.depth} agents deep` : "pool depth NOT measured"})`);

// GITHUB_OUTPUT is absent for a hand run, which prints the plan above and is the
// whole point of running it by hand.
// The driver list is emitted from the app's own `DRIVERS`, and the matrix and the
// judge's expectation both read it from here. Two places holding one number is how
// a matrix grows to five while the judge goes on expecting four and calls every run
// incomplete, or shrinks to three while the judge accepts a burst a driver short
// (L41, L70). The burst count is emitted the same way, from `BURST_LEGS`.
const drivers = Array.from({ length: DRIVERS }, (_, i) => i);
console.log(`  (${drivers.length} drivers, from the app's own DRIVERS constant)`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(
    out,
    // The plan is ONE value, so the drivers cannot fire at different codes, slots or
    // moments while each reads as correct (L70). JSON on one line, which is what a
    // GITHUB_OUTPUT value has to be.
    `burst_code=${CODE}\nburst_sibling_code=${SIBLING}\nburst_plan=${JSON.stringify(plan)}\n` +
      `burst_count=${plan.bursts.length}\n` +
      `drivers=${JSON.stringify(drivers)}\ndriver_count=${drivers.length}\n` +
      // Empty when it was not measured, which the judge reads as unmeasured. A
      // number here would be the assumption this whole change removes (L98).
      `burst_pool_depth=${reading.measured ? reading.depth : ""}\n`,
    "utf8",
  );
}
