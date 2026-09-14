// Picks the ONE bucket, the ONE slot and the ONE moment every burst driver uses
// (#2262), and writes them where the workflow's matrix can read them.
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
import { chooseBurstSlot, burstStartAt, offeredSlots, DRIVERS } from "./book-plan.ts";
import { burstCandidateOrder, type BurstDepthReading } from "./burst-target.ts";
import { poolDepthsFrom } from "./pool-depth.ts";
import { PRODUCTION_SUPABASE_REF, PRODUCTION_HOST } from "../../src/lib/loadtest-guard.ts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { Attributes, Criteria } from "@/lib/db/types";

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

/**
 * How many pools are asked what they are offering.
 *
 * `/api/availability` has its own per address ceiling (30 a minute) and this job
 * shares that address with everything else it does, so the walk down the depth
 * ordering is bounded rather than running the whole 60 code matrix.
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
let candidates: string[];
let depthByCode = new Map<string, number>();
if (CODE_OVERRIDE) {
  candidates = [CODE_OVERRIDE];
} else {
  let depths;
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
    // cap-safe: buckets is roster bounded, 60 codes
    const buckets = (unwrap(
      await db.from("buckets").select("id, code, criteria").eq("is_test", false),
      "burst target buckets",
    ) ?? []) as { id: string; code: string; criteria: Criteria | null }[];
    // cap-safe: bucket_members is roster bounded, a handful of hand named people
    const members = (unwrap(
      await db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
      "burst target members",
    ) ?? []) as { bucket_id: string; user_id: string }[];
    depths = poolDepthsFrom({ agents, buckets, members });
  } catch (err) {
    // Its OWN exit code. A roster this cannot read and a roster with nothing to
    // burst at send two different people to two different places (L11), and an
    // empty depth list would make every pool look unreachable and pick nothing.
    console.error(
      `FAILED: the pools could not be measured (${String(err)}), so the burst has no way to know ` +
        `how deep the pool it fires at is. Set the database credentials, or name a code with ` +
        `BURST_CODE_OVERRIDE and accept an unmeasured control.`,
    );
    process.exit(4);
  }
  depthByCode = new Map(depths.map((d) => [d.code, d.depth]));
  candidates = burstCandidateOrder(depths, CANDIDATES_TO_ASK);
  if (candidates.length === 0) {
    console.error(
      `FAILED: not one of the ${depths.length} pools has an agent in it, so there is nothing to ` +
        `burst at. The seed did not staff the roster.`,
    );
    process.exit(5);
  }
  console.log(
    `pools measured: asking ${candidates.map((c) => `${c} (${depthByCode.get(c)} deep)`).join(", ")}`,
  );
}

// Walk the candidates shallowest first and fire at the first that is offering. A
// pool one agent deep whose one agent has no free time offers nothing, so depth
// alone cannot choose: the strongest control is the shallowest pool that can
// actually be booked.
let CODE: string | null = null;
let slot: string | null = null;
let offeredCount = 0;
const readFailures: string[] = [];
for (const code of candidates) {
  let offered: string[] | null;
  try {
    offered = await offeredFor(code);
  } catch (err) {
    readFailures.push(`${code}: ${String(err)}`);
    continue;
  }
  if (offered === null) {
    readFailures.push(`${code}: availability did not answer`);
    continue;
  }
  const chosen = chooseBurstSlot(offered);
  if (chosen !== null) {
    CODE = code;
    slot = chosen;
    offeredCount = offered.length;
    break;
  }
}
if (CODE === null || slot === null) {
  // TWO exit codes, because a bucket offering nothing and an availability read
  // that failed send two different people to two different places (L11): the
  // first is a seed or a roster problem, the second is the deployment. The walk
  // over several candidates is what makes the distinction worth drawing at the
  // END rather than on the first bad read: one unreadable code among six that
  // answered is not the deployment being down.
  if (readFailures.length === candidates.length) {
    console.error(
      `FAILED: availability answered for none of ${candidates.join(", ")}, so no slot could be ` +
        `chosen and nothing is known about any pool. Reads: ${readFailures.join("; ")}.`,
    );
    process.exit(2);
  }
  console.error(
    `FAILED: none of ${candidates.join(", ")} offered a usable time, so there is nothing to burst ` +
      `at. The burst aims at the shallowest pools, so an empty answer here usually means the seed ` +
      `did not staff them.${readFailures.length > 0 ? ` Reads that did not answer: ${readFailures.join("; ")}.` : ""}`,
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
        why: "the code was named by BURST_CODE_OVERRIDE rather than measured",
      }
    : { measured: true, code: CODE, depth };

const startAt = burstStartAt(Date.now(), LEAD);
console.log(`burst: bucket ${CODE}, slot ${slot}, firing at ${new Date(startAt).toISOString()}`);
console.log(`  (chosen from ${offeredCount} offered times, ${Math.round(LEAD)}s from now)`);
console.log(`  (${reading.measured ? `pool ${reading.depth} agents deep` : "pool depth NOT measured"})`);

// GITHUB_OUTPUT is absent for a hand run, which prints the three values above and
// is the whole point of running it by hand.
// The driver list is emitted from the app's own `DRIVERS`, and the matrix and the
// judge's expectation both read it from here. Two places holding one number is how
// a matrix grows to five while the judge goes on expecting four and calls every run
// incomplete, or shrinks to three while the judge accepts a burst a driver short
// (L41, L70).
const drivers = Array.from({ length: DRIVERS }, (_, i) => i);
console.log(`  (${drivers.length} drivers, from the app's own DRIVERS constant)`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(
    out,
    `burst_code=${CODE}\nburst_slot=${slot}\nstart_at=${startAt}\n` +
      `drivers=${JSON.stringify(drivers)}\ndriver_count=${drivers.length}\n` +
      // Empty when it was not measured, which the judge reads as unmeasured. A
      // number here would be the assumption this whole change removes (L98).
      `burst_pool_depth=${reading.measured ? reading.depth : ""}\n`,
    "utf8",
  );
}
