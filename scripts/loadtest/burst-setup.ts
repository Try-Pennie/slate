// Picks the burst plan every burst driver fires (#2262, #3325, #3429): for each of the
// run's bursts its KIND, its two sibling codes, ONE slot, ONE moment, its share per
// driver and what was measured about its capacity, and writes it where the
// workflow's matrix can read it.
//
// TWO kinds of burst since #3429, because a crowd now walks the tier ladder like any
// confirm (#3338, #3437). A hundred confirms at a code whose lower rungs hold a whole
// tier mostly WIN, so the old aim (the shallowest pool) no longer tests the refusal
// path or the line's settle path at all:
//
// - the REFUSAL control fires its crowd of a hundred at the ladder whose WHOLE capacity,
//   the distinct advisors across every rung with the Low exclusion, is the smallest,
//   and only at one genuinely smaller than the crowd (`refusalLadders`). The ladder is a
//   bound at any slot, so somebody is refused whatever the slot. The booking API has no
//   named advisor link, the other way to give a crowd one advisor by construction: its
//   request names a bucket only (`parseDirectBookingRequest`), and the public booker
//   route that does take a link is behind per address ceilings and stamps no load test
//   echo, so the crowd is sized against a measured capacity instead.
// - the DROP burst fires about ten confirms at a ladder whose top rung is the
//   shallowest and whose ladder holds at least twice the crowd (`dropLadders`), at a
//   slot where, through the booker's own candidate read on every rung, the top rung has
//   somebody free and the ladder has room for twice the crowd (`dropSlotFit`). On a
//   build that walks the ladder every confirm wins, a rung down, on distinct advisors.
//
// Each burst at its own slot and moment and each judged on its own, because one burst
// is one spread of requests over the deployment's isolates and one lucky spread can
// pass a run a second would fail (L395). The slots are an hour apart so no burst's
// bookings overlap another's slot, and the moments are spaced past one burst's longest
// life, its probe included, so no two bursts overlap in time.
//
// Each burst is split across TWO codes whose fallback ladders are the same pools at
// every rung, MEASURED from the branch's own bucket rows through the booker's ladder and
// the recompute lane's pool key (#3325). The shared confirm line keys a crowd on the
// whole ladder, so the split is what proves the line ACROSS codes rather than only
// within one.
//
// Every figure is read through the app's own predicates rather than a copy of them
// (L107): the roster and its buckets through `listPoolBuckets` and the booker's own
// eligibility judge, and who is free at a slot through `roundRobinCandidates`, the read
// the confirm itself makes on each rung. What the setup measured travels in the plan to
// the report, so a reader knows what each control was worth (#2278).
//
// #3338 changed what that control can promise. A confirm in a crowd, or one that
// loses the insert race, now walks the tier ladder like any confirm (Dan,
// 2026-10-06), so a pool of one is "exactly one 200" only when it is the code's
// whole LADDER. The pool chosen here is the requested rung's; when rungs below it
// have people free, the crowd books them too (one 200 per free advisor across the
// ladder), or is told to retry when the line cannot serve it inside its wait, and
// is told SLOT_TAKEN only once a confirm found every rung spent. The judge's burst bar is
// rebuilt for that in #3429; until it is, read a burst's extra 200s on lower rungs
// as the ladder working, not a double booking.
//
// Finding nothing to burst at is NEVER a pass (L98). Every way of learning nothing
// exits non-zero on its own code with the reason, because the alternative is a burst
// leg that produced an empty file and a judge that reads it as a run with no burst.
//
// Run:
//   SLATE_BASE=https://<loadtest>.workers.dev BURST_LEAD_SECONDS=300 \
//   NEXT_PUBLIC_SUPABASE_URL=<branch> SUPABASE_SECRET_KEY=<branch key> \
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/burst-setup.ts
import { appendFileSync } from "node:fs";
import {
  burstStartAt,
  burstMoments,
  burstCrowd,
  offeredSlots,
  shownTierOf,
  DRIVERS,
  BURST_LEGS,
  BURST_SEQUENCE,
  BURST_SLOT_GAP_MS,
  DROP_SLOTS_TO_MEASURE,
  REFUSAL_SLOTS_TO_MEASURE,
  BURST_SPACING_MS,
  DROP_CAPACITY_HEADROOM,
  type BurstCapacity,
} from "./book-plan.ts";
import {
  assembleBurstPlan,
  dropLadders,
  dropSlotFit,
  chooseRefusalSlots,
  measuredFree,
  HARD_REFUSAL_MIN_FREE,
  ladderCandidates,
  ladderFreeFrom,
  readRetryingTimeouts,
  refusalLadders,
  rosterUnreadable,
  type LadderCandidate,
} from "./burst-target.ts";
import { poolDepthsFrom } from "./pool-depth.ts";
import { PRODUCTION_SUPABASE_REF, PRODUCTION_HOST } from "../../src/lib/loadtest-guard.ts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { listPoolBuckets } from "@/lib/availability/precompute";
import { resolveBucketByCode, roundRobinCandidates } from "@/lib/availability/service";
import { rungExcludesLow, tierLadder } from "@/lib/routing/tiers";
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

/**
 * How many ladders of each kind are asked what they are offering.
 *
 * `/api/availability` has its own per address ceiling (30 a minute) and this job
 * shares that address with everything else it does, so the walk is bounded rather
 * than running the whole matrix. Each ladder is two reads (#3325), so three of each
 * kind is at most twelve, inside the ceiling; in practice the first of each answers.
 */
const LADDERS_TO_ASK = 3;
// env-ok: BURST_LEAD_SECONDS (optional; defaults to 300, which has to cover a
// runner being queued, checked out and installed)
const LEAD = Number((process.env.BURST_LEAD_SECONDS ?? "300").trim());

const REFUSAL_CROWD = burstCrowd("refusal");
const DROP_CROWD = burstCrowd("drop");
const REFUSAL_BURSTS = BURST_SEQUENCE.filter((k) => k === "refusal").length;

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

/**
 * What one code is offering, and the tier its answer had on show (#3495), or null when
 * the deployment would not answer for it.
 */
async function offeredFor(code: string): Promise<{ times: string[]; shownTier: string | null } | null> {
  const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${code}`);
  if (!res.ok) return null;
  // Through the shared reader (#2261), which THROWS on a payload it cannot read
  // rather than resolving to an empty list: an unreadable shape would otherwise
  // arrive here as "this bucket offers nothing" and refuse the run for the wrong
  // reason entirely.
  const body: unknown = await res.json();
  return { times: offeredSlots(body), shownTier: shownTierOf(body) };
}

/**
 * The times BOTH codes of a ladder offer, and the tier each had on show (#3495), or
 * why they could not be read.
 */
async function sharedOffered(
  c: LadderCandidate,
): Promise<{ times: string[]; shownTiers: [string | null, string | null] } | { why: string }> {
  try {
    const offered = await offeredFor(c.code);
    const sibling = offered === null ? null : await offeredFor(c.sibling);
    if (offered === null || sibling === null) return { why: `${c.code}/${c.sibling}: availability did not answer` };
    // Each sibling is asked too, because a time only one of the two offers would be
    // refused for the other half of the burst for a reason that is not contention.
    const both = new Set(sibling.times);
    return { times: offered.times.filter((t) => both.has(t)), shownTiers: [offered.shownTier, sibling.shownTier] };
  } catch (err) {
    return { why: `${c.code}/${c.sibling}: ${String(err)}` };
  }
}

/**
 * Who is free at `slot` on each rung of `code`'s ladder, through the booker's OWN
 * candidate read (`roundRobinCandidates`, read only), with the bucket each rung
 * resolves to and the Low exclusion the booking cascade applies (L107). A rung with no
 * bucket, or a hidden test bucket, is an empty list, as the cascade skips both.
 */
async function ladderFreeAt(code: string, slot: string): Promise<{ rung0Free: number; ladderFree: number }> {
  const startMs = Date.parse(slot);
  const perRung: string[][] = [];
  for (const rung of tierLadder(code)) {
    const resolved = await resolveBucketByCode(rung);
    if (!resolved || resolved.bucket.is_test) {
      perRung.push([]);
      continue;
    }
    const { candidates } = await roundRobinCandidates(
      resolved.bucket,
      resolved.eventType,
      startMs,
      true, // preview: read only, and no unfair ordering alert
      undefined,
      rungExcludesLow(code, rung),
    );
    perRung.push(candidates);
  }
  return ladderFreeFrom(perRung);
}

/**
 * `ladderFreeAt`, or the refusal its own exit code names when the read fails (L11).
 * A read that only timed out is asked again, visibly, before that (#3737).
 */
async function measuredCapacity(c: LadderCandidate, slot: string): Promise<BurstCapacity> {
  let reason: string;
  try {
    const read = await readRetryingTimeouts(() => ladderFreeAt(c.code, slot), {
      onRetry: (line) => console.log(`  ${c.code} at ${slot}: ${line}`),
    });
    if (read.ok) return { ladderRoster: c.ladderRoster, rung0Free: read.value.rung0Free, ladderFree: read.value.ladderFree };
    reason = read.reason;
  } catch (err) {
    reason = String(err);
  }
  console.error(
    `FAILED: who is free at ${slot} on ${c.code}'s ladder could not be read (${reason}), so the burst's ` +
      "capacity there is unknown and the crowd cannot be sized against it.",
  );
  process.exit(10);
}

// --- the roster and its ladders, measured -----------------------------------------
/** One setup read, asked again when it only timed out (#3737); throws when it cannot answer. */
async function readOrThrow<T>(what: string, read: () => Promise<T>): Promise<T> {
  const r = await readRetryingTimeouts(read, { onRetry: (line) => console.log(`  ${what}: ${line}`) });
  if (r.ok) return r.value;
  throw new Error(r.reason);
}
let candidates: LadderCandidate[];
let staffedPools = 0;
let poolCount = 0;
try {
  const db = supabaseAdmin();
  // cap-safe: users is roster bounded, the seeded roster is ~94 rows against a
  // 200-agent design target
  const agents = ((await readOrThrow("the roster", async () =>
    unwrap(
      await db
        .from("users")
        .select("id, attributes")
        .eq("bookable", true)
        .is("deactivated_at", null)
        .eq("is_test", false),
      "burst target agents",
    ),
  )) ?? []) as { id: string; attributes: Attributes | null }[];
  // The buckets and their hand named members through the app's OWN pool reader
  // (#3325), the one the recompute lane groups on, so the ladders below are read from
  // exactly the inputs the booker uses (L107). Test buckets are left out, as the
  // booking cascade leaves them out of every routed ladder.
  const rows = (await readOrThrow("the pool buckets", () => listPoolBuckets())).filter((r) => !r.bucket.is_test);
  const depths = poolDepthsFrom({
    agents,
    buckets: rows.map((r) => ({ id: r.bucket.id, code: r.code, criteria: r.criteria })),
    members: rows.flatMap((r) => r.memberIds.map((user_id) => ({ bucket_id: r.bucket.id, user_id }))),
  });
  poolCount = depths.length;
  staffedPools = depths.filter((d) => d.depth > 0).length;
  candidates = ladderCandidates(
    rows.map((r) => ({
      code: r.code,
      orgId: r.orgId,
      eventTypeId: r.eventTypeId,
      criteria: r.criteria,
      fallbackUserId: r.fallbackUserId,
      memberIds: r.memberIds,
    })),
    agents,
  );
} catch (err) {
  // Its OWN exit code. A roster this cannot read and a roster with nothing to burst at
  // send two different people to two different places (L11), and an empty list would
  // make every ladder look unreachable and pick nothing.
  console.error(rosterUnreadable(err instanceof Error ? err.message : String(err)));
  process.exit(4);
}
if (staffedPools === 0) {
  console.error(
    `FAILED: not one of the ${poolCount} pools has an agent in it, so there is nothing to burst at. The seed did ` +
      "not staff the roster.",
  );
  process.exit(5);
}
const staffed = candidates.filter((c) => c.ladderRoster > 0);
if (staffed.length === 0) {
  // The roster has agents, and no two codes share a fallback ladder, so a burst cannot
  // be split across codes the shared line treats as one (#3325). A property of the
  // bucket rows, never the deployment.
  console.error(
    "FAILED: no staffed code shares its whole fallback ladder with another code on this branch, so no burst " +
      "can be split across two codes of one line. Two codes qualify when every rung of their ladders resolves to " +
      "the same pool (criteria, members, fallback advisor, event type); a hand named member or a fallback advisor " +
      "on one bucket splits it from its siblings.",
  );
  process.exit(6);
}
console.log(
  `ladders measured: ${staffed
    .map((c) => `${c.code}/${c.sibling} (${c.rungs} rungs, top ${c.rung0Roster}, whole ${c.ladderRoster})`)
    .join(", ")}`,
);

// --- the refusal control: the smallest ladder under its crowd ---------------------
const refusalAsk = refusalLadders(staffed, REFUSAL_CROWD).slice(0, LADDERS_TO_ASK);
if (refusalAsk.length === 0) {
  const smallest = Math.min(...staffed.map((c) => c.ladderRoster));
  console.error(
    `FAILED: no ladder holds fewer advisors than the refusal crowd of ${REFUSAL_CROWD} (the smallest holds ` +
      `${smallest}), so no crowd here is genuinely larger than what it can book and the refusal path would go ` +
      "untested. A refusal control sized at its capacity proves nothing (L63).",
  );
  process.exit(7);
}

const refusalChoice = await chooseRefusalSlots(
  refusalAsk,
  { offered: sharedOffered, free: measuredCapacity, label: (c) => c.code },
  { bursts: REFUSAL_BURSTS, gapMs: BURST_SLOT_GAP_MS, toMeasure: REFUSAL_SLOTS_TO_MEASURE, minFree: HARD_REFUSAL_MIN_FREE },
);
if (refusalChoice.kind !== "chosen") {
  // Each outcome its own exit code, because each sends a different person to a different
  // place (L11): a failed read is the deployment; a ladder with no time fit for the hard
  // crowd (#3565) or no well spaced times is the seed or the roster.
  const asked = refusalAsk.map((c) => `${c.code}/${c.sibling}`).join(", ");
  const reads = refusalChoice.reads.length > 0 ? ` Reads that did not answer: ${refusalChoice.reads.join("; ")}.` : "";
  if (refusalChoice.kind === "unanswered") {
    console.error(
      `FAILED: availability answered for none of the refusal control's ladders (${asked}), so no slot could be ` +
        `chosen and nothing is known about any of them. Reads: ${refusalChoice.reads.join("; ")}.`,
    );
    process.exit(2);
  }
  if (refusalChoice.kind === "no-hard-slot") {
    const m = refusalChoice.misses;
    console.error(
      `FAILED: no offered time on the refusal control's ladders (${asked}) has ${HARD_REFUSAL_MIN_FREE} or more ` +
        `advisors free across the ladder with some below the requested rung, so the hard crowd (#3565) has nothing ` +
        `to meet. Measured: ${m.slice(0, 6).join("; ")}${m.length > 6 ? `; and ${m.length - 6} more` : ""}.${reads}`,
    );
    process.exit(11);
  }
  console.error(
    `FAILED: none of the refusal control's ladders (${asked}) offered ${REFUSAL_BURSTS} times at least ` +
      `${BURST_SLOT_GAP_MS / 60_000} minutes apart that both codes offer, so there is nothing to burst at.${reads}`,
  );
  process.exit(3);
}
const refusal = refusalChoice.ladder;
const refusalSlots = refusalChoice.slots;
const refusalTiers = refusalChoice.shownTiers;

// --- the drop burst: a shallow top rung with room below, at a slot that fits --------
const dropAsk = dropLadders(staffed, DROP_CROWD, DROP_CAPACITY_HEADROOM, [refusal.code]).slice(0, LADDERS_TO_ASK);
if (dropAsk.length === 0) {
  console.error(
    `FAILED: no ladder can host the tier drop burst: one needs a sibling code, somebody on its top rung, a rung ` +
      `below it, and room for ${DROP_CAPACITY_HEADROOM} times the crowd of ${DROP_CROWD} across the ladder, and is ` +
      `never the refusal control's own (${refusal.code}).`,
  );
  process.exit(8);
}
const farEnough = (t: string) => refusalSlots.every((s) => Math.abs(Date.parse(s) - Date.parse(t)) >= BURST_SLOT_GAP_MS);
const dropReads: string[] = [];
const dropMisses: string[] = [];
let drop: { ladder: LadderCandidate; slot: string; capacity: BurstCapacity; shownTiers: [string | null, string | null] } | null = null;
for (const c of dropAsk) {
  const shared = await sharedOffered(c);
  if ("why" in shared) {
    dropReads.push(shared.why);
    continue;
  }
  // The furthest first, as every burst slot is chosen, and never within the gap of a
  // refusal slot, so no burst's bookings sit on another's slot.
  const times = shared.times
    .filter((t) => Number.isFinite(Date.parse(t)) && farEnough(t))
    .sort((a, b) => Date.parse(b) - Date.parse(a))
    .slice(0, DROP_SLOTS_TO_MEASURE);
  for (const t of times) {
    const capacity = await measuredCapacity(c, t);
    const free = measuredFree(capacity);
    const why = free ? dropSlotFit(free, DROP_CROWD, DROP_CAPACITY_HEADROOM) : "who is free there was not measured";
    if (why === null) {
      drop = { ladder: c, slot: t, capacity, shownTiers: shared.shownTiers };
      break;
    }
    dropMisses.push(`${c.code} at ${t}: ${why}`);
  }
  if (drop !== null) break;
  if (times.length === 0) dropMisses.push(`${c.code}/${c.sibling}: offered no time an hour from both refusal slots`);
}
if (drop === null) {
  if (dropReads.length === dropAsk.length) {
    console.error(
      `FAILED: availability answered for none of the drop burst's ladders ` +
        `(${dropAsk.map((c) => `${c.code}/${c.sibling}`).join(", ")}). Reads: ${dropReads.join("; ")}.`,
    );
    process.exit(2);
  }
  console.error(
    `FAILED: no offered time fits the tier drop burst (somebody free on the top rung, fewer than the crowd of ` +
      `${DROP_CROWD} there, room for ${DROP_CAPACITY_HEADROOM} times the crowd across the ladder). Measured: ` +
      `${dropMisses.slice(0, 6).join("; ")}${dropMisses.length > 6 ? `; and ${dropMisses.length - 6} more` : ""}.` +
      (dropReads.length > 0 ? ` Reads that did not answer: ${dropReads.join("; ")}.` : ""),
  );
  process.exit(9);
}

// What each refusal slot held when planned, for the report. Its ladder is the bound
// either way; this says how strong the control was at the slot it fired at.
const refusalCapacities: BurstCapacity[] = [];
for (const s of refusalSlots) refusalCapacities.push(await measuredCapacity(refusal, s));

// --- the plan ----------------------------------------------------------------------
const startAt = burstStartAt(Date.now(), LEAD);
const moments = burstMoments(startAt, BURST_LEGS, BURST_SPACING_MS);
const plan = assembleBurstPlan(
  BURST_SEQUENCE,
  moments,
  { codes: [refusal.code, refusal.sibling], shownTiers: refusalTiers, slots: refusalSlots, capacities: refusalCapacities },
  { codes: [drop.ladder.code, drop.ladder.sibling], shownTiers: drop.shownTiers, slot: drop.slot, capacity: drop.capacity },
);
console.log(`burst plan: ${plan.bursts.length} bursts`);
for (const [i, b] of plan.bursts.entries()) {
  console.log(
    `  burst ${i + 1} (${b.kind}): ${b.codes.join(" with ")} (tiers on show ${b.shownTiers.join(", ")}), slot ${b.slot}, firing at ` +
      `${new Date(b.startAtMs).toISOString()}, ${b.perDriver} a driver; its ladder holds at most ` +
      `${b.capacity.ladderRoster}, ${b.capacity.ladderFree} free at the slot (${b.capacity.rung0Free} on the top rung)`,
  );
}

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
    // GITHUB_OUTPUT value has to be. What each burst was worth travels inside it, to
    // the drivers' files and from there to the report.
    `burst_plan=${JSON.stringify(plan)}\n` +
      `burst_count=${plan.bursts.length}\n` +
      `drivers=${JSON.stringify(drivers)}\ndriver_count=${drivers.length}\n`,
    "utf8",
  );
}
