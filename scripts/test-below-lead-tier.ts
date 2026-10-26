// A booking whose pool sits below the lead's Salesforce tier (#2593). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-below-lead-tier.ts
//
// The rate check (`catchall_rate`) cannot see one Ultra High lead booked with the
// Low team: two bookings in twelve hundred do not move a share. So this compares
// every upcoming real booking's pool tier against the tier the lead's CURRENT
// Salesforce score decodes to, and pages per booking when the lead sits HIGHER.
//
// What this file pins:
//  - both directions: a lead ABOVE the pool pages, a lead EQUAL to or BELOW it is
//    silent (the healthy case must never read as the fault);
//  - `absent` and `unreadable` stay apart, and neither is agreement;
//  - a failed read (bookings or Salesforce) measures nothing: no page, no all
//    clear, no verdict;
//  - comparing zero bookings is never a verdict (L98);
//  - the all clear hangs off a MEASURED healthy booking, or a booking the read
//    measured as no longer upcoming, never off a booking it could not measure;
//  - a booking made from a known test source (#2737: a host page that is not the
//    production site, the SAME predicate the off site page uses) is excluded, so a
//    test booking in a real bucket is never the verdict that un-parks this check;
//  - #2594: a lead re-scored AFTER booking is told apart from one routed below its
//    own code, by the code the lead arrived with (`routing_decisions.requested_code`),
//    and the page names both the old code and tier and the new ones.
//  - #3501: the score judged is the one on the lead's CURRENT submission, which is
//    what the booking link carries, never the copy on the Lead record, which can
//    lag it; and "re-scored" is said only when the booking's own submission was.
import {
  BELOW_LEAD_TIER_KEY,
  belowLeadTierKey,
  compareBookingsToLeadTier,
  formatBelowLeadTierAlert,
  isLeadId,
  leadIdOf,
  leadTierOf,
  poolTierOf,
  runBelowLeadTierCheck,
  type BelowLeadTierDeps,
  type PageFacts,
  type PoolBucket,
  type UpcomingBooking,
} from "@/lib/monitor/below-lead-tier";
import { belowLeadTierReachedVerdict } from "@/lib/monitor/verdict-freshness";
import { readLeadScores, leadIdKey, type LeadScore, type LeadFieldRecord } from "@/lib/salesforce/lead-xbc";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { CHANGE_ONLY_HOLD_MS } from "@/lib/notify/repeat-policy";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 8, 24, 14, 0, 0);
const LEAD_A = "00QUi00000zhEUPMA2"; // 18 characters
const LEAD_B = "00QUi00000abcdeFGH";
const LEAD_C = "00QUi00000qwertYUI";

const LOW: PoolBucket = { id: "b-100", code: "100", name: "Low | None | No Legal Param", criteria: { debt_team: "low" } };
const ULTRA: PoolBucket = { id: "b-512", code: "512", name: "Ultra High | Both | Non-Legal", criteria: { debt_team: "ultra_high" } };
const MEDIUM: PoolBucket = { id: "b-211", code: "211", name: "Medium | Both | Legal", criteria: { debt_team: "medium" } };
const VERY_HIGH: PoolBucket = { id: "b-422", code: "422", name: "Very High | Both | Non-Legal", criteria: { debt_team: "very_high" } };
const BUCKETS = [LOW, ULTRA, MEDIUM, VERY_HIGH];

function booking(over: Partial<UpcomingBooking> = {}): UpcomingBooking {
  return {
    id: "bk-1",
    bucket_id: LOW.id,
    starts_at: new Date(NOW + 26 * 60 * 60_000).toISOString(),
    salesforce_id: LEAD_A,
    external_id: null,
    agent_name: "Dana Whitfield",
    agent_email: "dana.whitfield@trypennie.com",
    prefill: { parentOrigin: "https://www.trypennie.com", embed: "1" },
    referrer_origin: "https://www.trypennie.com",
    ...over,
  };
}

const SUB_A = "a04Ui00000subAAAAA";

/** #3665's facts held constant, so the copy tests here are about the routing
 *  sentence; scripts/test-below-lead-tier-team-free.ts drives every value of them. */
const FACTS: PageFacts = { team: { kind: "free" }, history: { kind: "steady" } };

/** A finding whose score came from the very submission the booking was made under:
 *  the one shape that may be called a re-score (#3501). */
function rescoredOwnSubmission<F extends { booking: UpcomingBooking; lead: { code: string } }>(f: F): F & { score: LeadScore } {
  return {
    ...f,
    booking: { ...f.booking, prefill: { ...f.booking.prefill, [PARTNER_KEYS.submissionId]: SUB_A } },
    score: { code: f.lead.code, source: "submission", submissionId: SUB_A },
  };
}

// --- decoding: through xbc.ts, never a second decoder -------------------------------
{
  eq(leadTierOf("512"), { kind: "tier", rank: 5, key: "ultra_high", label: "Ultra High", code: "512" }, "512 is Ultra High");
  eq(leadTierOf(" 100 ").kind, "tier", "surrounding space is not a different value");
  eq(leadTierOf(null).kind, "absent", "no XBC on the lead is absent");
  eq(leadTierOf("").kind, "absent", "an empty XBC is absent");
  eq(leadTierOf("   ").kind, "absent", "a blank XBC is absent");
  // Measured 2026-09-24: 45 percent of the newest 2,000 leads carry a first digit
  // of 0 (011, 012, 000), which xbc.ts does not decode. It is a value, not a gap,
  // so it must read as UNREADABLE and never as absent.
  eq(leadTierOf("011").kind, "unreadable", "a tier digit xbc.ts does not know is unreadable");
  eq(leadTierOf("5120").kind, "unreadable", "four digits is unreadable");
  eq(leadTierOf("abc").kind, "unreadable", "letters are unreadable");

  eq(poolTierOf(ULTRA), { rank: 5, label: "Ultra High" }, "a seeded bucket's tier comes from its code");
  eq(poolTierOf({ id: "x", code: "HANDMADE", name: "p", criteria: { debt_team: "medium" } }), { rank: 2, label: "Medium" }, "a hand made bucket falls back to its criteria");
  eq(poolTierOf({ id: "x", code: "HANDMADE", name: "p", criteria: {} }), null, "no code and no criteria tier: unknown");
  eq(poolTierOf({ id: "x", code: "HANDMADE", name: "p", criteria: { debt_team: ["low", "high"] } }), { rank: 3, label: "High" }, "a pool spanning tiers is judged by its highest");
}

// --- which id is a Lead id ------------------------------------------------------------
{
  assert(isLeadId(LEAD_A), "an 18 character 00Q id is a lead id");
  assert(isLeadId(LEAD_A.slice(0, 15)), "a 15 character 00Q id is a lead id");
  assert(!isLeadId("pilot1234567890"), "the pilot's made up id is not a lead id");
  assert(!isLeadId("003000000000000AAA"), "a Contact id is not a lead id");
  assert(!isLeadId("00Q0000000000000000000"), "a 22 character value is not a lead id");
  eq(leadIdOf(booking({ salesforce_id: null, external_id: LEAD_B })), LEAD_B, "the API writes the lead id to external_id");
  eq(leadIdOf(booking({ salesforce_id: LEAD_A, external_id: LEAD_B })), LEAD_A, "salesforce_id wins when both are set");
  eq(leadIdOf(booking({ salesforce_id: null, external_id: null })), null, "neither set: no lead id");
  // A blank salesforce_id is not an id, so it must not hide a real external_id:
  // `??` falls through only on null, which would score this booking no-lead-id.
  eq(leadIdOf(booking({ salesforce_id: "", external_id: LEAD_B })), LEAD_B, "an empty salesforce_id falls through to external_id");
  eq(leadIdOf(booking({ salesforce_id: "   ", external_id: LEAD_B })), LEAD_B, "a whitespace salesforce_id falls through to external_id");
  eq(leadIdOf(booking({ salesforce_id: "  ", external_id: " " })), null, "two blanks: no lead id");
  eq(leadIdKey(LEAD_A), leadIdKey(LEAD_A.slice(0, 15)), "15 and 18 character spellings of one id share a key");
}

// --- the comparison, both directions ---------------------------------------------------
{
  const leads = new Map<string, string | null>([
    [leadIdKey(LEAD_A), "512"],
    [leadIdKey(LEAD_B), "111"],
    [leadIdKey(LEAD_C), null],
  ]);
  const out = compareBookingsToLeadTier(
    [
      booking({ id: "above", bucket_id: LOW.id, salesforce_id: LEAD_A }),
      booking({ id: "equal", bucket_id: LOW.id, salesforce_id: LEAD_B }),
      booking({ id: "lower", bucket_id: ULTRA.id, salesforce_id: LEAD_B }),
      booking({ id: "absent", salesforce_id: LEAD_C }),
      booking({ id: "no-id", salesforce_id: null, external_id: null }),
      booking({ id: "not-lead", salesforce_id: "pilot1234567890" }),
      booking({ id: "not-found", salesforce_id: "00QUi00000zzzzzZZZ" }),
      booking({ id: "short-id", bucket_id: MEDIUM.id, salesforce_id: LEAD_A.slice(0, 15) }),
      booking({ id: "bad-pool", bucket_id: "gone" }),
    ],
    BUCKETS,
    leads,
  );
  const kind = (id: string) => out.find((c) => c.booking.id === id);
  eq(kind("above")?.kind, "below", "an Ultra High lead in the Low pool is the finding");
  eq(kind("equal")?.kind, "agrees", "a lead whose tier EQUALS the pool is silent");
  eq(kind("lower")?.kind, "agrees", "a lead BELOW the pool is silent too");
  const reason = (id: string) => {
    const c = kind(id);
    return c && c.kind === "unmeasured" ? c.reason : c?.kind;
  };
  eq(reason("absent"), "xbc-absent", "a lead with no XBC is unmeasured as absent");
  eq(reason("no-id"), "no-lead-id", "a booking with no Salesforce id is unmeasured");
  eq(reason("not-lead"), "not-a-lead-id", "an id that is not a Lead id is unmeasured");
  eq(reason("not-found"), "lead-not-found", "a lead Salesforce did not return is unmeasured");
  eq(kind("short-id")?.kind, "below", "a stored 15 character id matches Salesforce's 18 character answer");
  eq(reason("bad-pool"), "pool-tier-unknown", "a booking whose pool has no tier is unmeasured");

  const unreadable = compareBookingsToLeadTier(
    [booking({ salesforce_id: LEAD_A })],
    BUCKETS,
    new Map([[leadIdKey(LEAD_A), "011"]]),
  );
  eq(unreadable[0].kind === "unmeasured" && unreadable[0].reason, "xbc-unreadable", "a value that does not decode is unreadable, not agreement");
}

// --- the copy ---------------------------------------------------------------------------
{
  const [finding] = compareBookingsToLeadTier(
    [booking({ salesforce_id: LEAD_A })],
    BUCKETS,
    new Map([[leadIdKey(LEAD_A), "512"]]),
  );
  if (finding.kind !== "below") throw new Error("fixture must be a finding");
  const withCatchall = formatBelowLeadTierAlert(finding, { catchall: true, requestedCode: "", tierFallback: false, rungsDropped: 0 }, "https://slate.example/admin/bookings/bk-1", FACTS);
  assert(withCatchall.startsWith("An Ultra High lead"), "the page names the lead's tier, with the right article");
  assert(withCatchall.includes("Low"), "the page names the pool's tier");
  assert(withCatchall.includes("512"), "the page names the XBC Salesforce holds");
  assert(withCatchall.includes("Dana Whitfield"), "the page names the agent holding the call");
  assert(withCatchall.includes("https://slate.example/admin/bookings/bk-1"), "the page links the booking");
  assert(/catch-all chose/i.test(withCatchall), "a catch-all booking says the catch-all chose the pool");
  assert(
    !/catch-all chose/i.test(formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: null, tierFallback: false, rungsDropped: 0 }, "u", FACTS)),
    "a routed booking does not blame the catch-all",
  );
  assert(/not recorded/i.test(formatBelowLeadTierAlert(finding, null, "u", FACTS)), "an unknown routing record says so rather than guessing");
  assert(/could not be read/i.test(formatBelowLeadTierAlert(finding, "unreadable", "u", FACTS)), "an unreadable routing record says so");
  assert(!/[\u2014\u2013]/.test(withCatchall), "no dashes in the page");
  assert(!/NaN|undefined|null/.test(withCatchall), "no leaked values in the page");
  eq(belowLeadTierKey("bk-1"), `${BELOW_LEAD_TIER_KEY}:bk-1`, "the key family is per booking");
}

// --- #2594: re-scored after booking, against routed below its own code ------------------
{
  // The 2026-09-21 shape: booked on XBC 422 into the Very High pool, then Salesforce
  // re-scored the lead to 512 four minutes later.
  const [finding] = compareBookingsToLeadTier(
    [booking({ bucket_id: VERY_HIGH.id, salesforce_id: LEAD_A })],
    BUCKETS,
    new Map([[leadIdKey(LEAD_A), "512"]]),
  );
  if (finding.kind !== "below") throw new Error("fixture must be a finding");
  const rescored = formatBelowLeadTierAlert(rescoredOwnSubmission(finding), { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(/re-scored/i.test(rescored), "a lead who arrived on a lower code than today's is named as re-scored");
  assert(/XBC 422 \(Very High\)/.test(rescored), "the page names the OLD code and the tier it decodes to");
  assert(/XBC 512/.test(rescored) && rescored.startsWith("An Ultra High lead"), "and the NEW code and tier");
  assert(rescored.includes("bucket 422"), "and the bucket holding the call");
  assert(!/catch-all chose/i.test(rescored), "and does not blame the catch-all");
  assert(!/either that code was lower/i.test(rescored), "and states the measured cause rather than two guesses");
  assert(!/[\u2014\u2013]/.test(rescored), "no dashes in the page");

  // Arrived on the code Salesforce holds today, and still placed lower: the score did
  // not move, so saying it was re-scored would send somebody to Salesforce for nothing.
  const [lowFinding] = compareBookingsToLeadTier(
    [booking({ salesforce_id: LEAD_A })],
    BUCKETS,
    new Map([[leadIdKey(LEAD_A), "512"]]),
  );
  if (lowFinding.kind !== "below") throw new Error("fixture must be a finding");
  const sameCode = formatBelowLeadTierAlert(lowFinding, { catchall: false, requestedCode: "512", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(!/re-scored/i.test(sameCode), "a lead who arrived on today's code is not called re-scored");
  assert(/XBC 512 \(Ultra High\)/.test(sameCode), "it names the code the lead arrived with");
  assert(/below the code it was given/i.test(sameCode), "and says the routing placed the call below that code");

  // Both at once: arrived on a lower code than today's AND placed below even that
  // code. Calling it only a re-score would hide a routing fault, and "was routed on
  // it" would be false, so the page must name both causes.
  if (lowFinding.pool.rank >= 4) throw new Error("fixture must sit below the Very High pool");
  const both = formatBelowLeadTierAlert(rescoredOwnSubmission(lowFinding), { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(/re-scored/i.test(both), "a lead re-scored above an arrival code still reads as re-scored");
  assert(/below the code it was given/i.test(both), "and a pool below the arrival code is still named as a routing fault");
  assert(!/was routed on it/i.test(both), "and never claims the call was routed on the arrival code");

  // #3501: a finding that does not say where its score came from claims no re-score,
  // because a Lead's lagging copy reads exactly like one (the 2026-10-07 page).
  const unattributed = formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(/could not tell/.test(unattributed) && !/submission they booked from/.test(unattributed), "a score of unknown source claims no cause");
  const unattributedBoth = formatBelowLeadTierAlert(lowFinding, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(/could not tell/.test(unattributedBoth) && /below the code it was given/i.test(unattributedBoth), "and still names a routing fault beside it");

  // An arrival code in the same tier as today's score is not a re-score either.
  const sameTier = formatBelowLeadTierAlert(lowFinding, { catchall: false, requestedCode: "501", tierFallback: false, rungsDropped: 0 }, "u", FACTS);
  assert(!/re-scored/i.test(sameTier), "an arrival code in today's tier is never called re-scored");

  // No readable arrival code: fall back to the two possible causes, naming neither as fact.
  for (const code of [null, "", "011", "  "]) {
    const t = formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: code }, "u", FACTS);
    assert(!/re-scored/i.test(t) && !/below the code it was given/i.test(t), `an arrival code of ${JSON.stringify(code)} claims no cause`);
    assert(/either that code was lower/i.test(t), `and names both possibilities for ${JSON.stringify(code)}`);
    assert(!/NaN|undefined|null/.test(t), "no leaked values");
  }

  // The catch-all line wins over any arrival code: its code was blank or unreadable.
  assert(
    /catch-all chose/i.test(formatBelowLeadTierAlert(finding, { catchall: true, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, "u", FACTS)),
    "a catch-all booking says so whatever code it carried",
  );
}

// --- the runner -------------------------------------------------------------------------
/** A code per lead as `readLeadScores` answers it, read off the Lead's copy: the
 *  shape every fake below meant before #3501 split the score from its source. */
function asScores(codes: Map<string, string | null>): Map<string, LeadScore> {
  return new Map([...codes].map(([k, code]) => [k, { code, source: "lead" as const, submissionId: null }]));
}

type Calls = {
  notified: { key: string; text: string; cooldown: number; subjects: readonly string[] | undefined }[];
  resolved: { key: string; text: string }[];
  sfQueries: number;
};

function deps(over: Partial<BelowLeadTierDeps> = {}, calls: Calls = { notified: [], resolved: [], sfQueries: 0 }): BelowLeadTierDeps {
  return {
    loadBookings: async () => [booking({ id: "bk-1", salesforce_id: LEAD_A }), booking({ id: "bk-2", bucket_id: ULTRA.id, salesforce_id: LEAD_B })],
    buckets: BUCKETS,
    readLeadScores: async (ids) => {
      calls.sfQueries++;
      const m = new Map<string, string | null>();
      for (const id of ids) m.set(leadIdKey(id), id === LEAD_A ? "512" : "111");
      return asScores(m);
    },
    loadRoutingContext: async () => new Map([["bk-1", { catchall: true, requestedCode: "", tierFallback: false, rungsDropped: 0 }]]),
    listFiring: async () => new Set<string>(),
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    armed: true,
    notify: async (key, cooldown, text, repeat) => {
      calls.notified.push({ key, text, cooldown, subjects: repeat?.subjects });
    },
    settle: async (keys) => {
      for (const key of keys) calls.resolved.push({ key, text: "" });
    },
    nowMs: NOW,
    leadTierOffer: () => null,
    readSubmissionHistory: async () => new Map(),
    ...over,
  };
}

async function main(): Promise<void> {
  // A planted violation pages, once, on its own key; the healthy booking beside it is silent.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(deps({}, calls));
    eq(r.status, "measured", "a run that read both sides is measured");
    if (r.status === "measured") {
      eq(r.compared, 2, "it reports how many bookings it COMPARED");
      eq(r.below.map((b) => b.booking.id), ["bk-1"], "only the booking below the lead's tier is a finding");
      eq(r.paged, true, "armed, so it paged");
    }
    eq(calls.notified.map((n) => n.key), [belowLeadTierKey("bk-1")], "one page, keyed to the booking");
    // 2026-10-26: once per call. The hold is the change only interval, never a
    // setting, and the page names what a change would be.
    eq(calls.notified[0]?.cooldown, CHANGE_ONLY_HOLD_MS, "held for the change only interval, not a tunable cooldown");
    eq(
      calls.notified[0]?.subjects,
      [`call:${new Date(NOW + 26 * 60 * 60_000).toISOString()}`, "advisor:dana.whitfield@trypennie.com", "bucket:100", "tier:ultra_high"],
      "the page names the call, its advisor and bucket, and the lead's tier",
    );
    assert(/catch-all chose/i.test(calls.notified[0]?.text ?? ""), "the catch-all context reaches the page");
    eq(calls.resolved.length, 0, "nothing was firing, so nothing clears");
    assert(belowLeadTierReachedVerdict(r), "a measured run that compared bookings stamps a verdict");
  }

  // Disarmed: measure and report, send nothing, clear nothing.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps({ armed: false, listFiring: async () => new Set(["bk-2"]) }, calls),
    );
    eq(r.status === "measured" && r.below.length, 1, "disarmed still measures the finding");
    eq(r.status === "measured" && r.paged, false, "and says it did not page");
    eq(calls.notified.length + calls.resolved.length, 0, "disarmed sends nothing in either direction");
    assert(belowLeadTierReachedVerdict(r), "a disarmed run still concluded, so it still stamps");
  }

  // The Salesforce read fails: unmeasured. No page, no all clear, no verdict.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          readLeadScores: async () => {
            throw new Error("SF query failed: 503");
          },
          listFiring: async () => new Set(["bk-1", "bk-2"]),
        },
        calls,
      ),
    );
    eq(r.status, "unreadable", "a failed Salesforce read is unreadable");
    eq(r.status === "unreadable" && r.stage, "salesforce", "and names which read failed");
    eq(calls.notified.length, 0, "no page off a read that failed");
    eq(calls.resolved.length, 0, "and no all clear off it either");
    assert(!belowLeadTierReachedVerdict(r), "and no verdict");
  }

  // The bookings read fails: the same, and Salesforce is never asked.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => {
            throw new Error("bookings read failed");
          },
          listFiring: async () => new Set(["bk-1"]),
        },
        calls,
      ),
    );
    eq(r.status === "unreadable" && r.stage, "bookings", "a failed bookings read is unreadable");
    eq(calls.sfQueries, 0, "Salesforce is not asked about bookings nobody read");
    eq(calls.notified.length + calls.resolved.length, 0, "nothing sent either way");
    assert(!belowLeadTierReachedVerdict(r), "no verdict");
  }

  // Nothing to compare is never a verdict, and costs no Salesforce call.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(deps({ loadBookings: async () => [] }, calls));
    eq(r.status === "measured" && r.compared, 0, "zero bookings compared");
    assert(!belowLeadTierReachedVerdict(r), "comparing zero is never a verdict");
    eq(calls.sfQueries, 0, "no bookings, no Salesforce call");
    assert(!belowLeadTierReachedVerdict(null), "a step that threw concluded nothing");
  }

  // Only unmeasurable bookings: measured run, compared zero, no verdict, nothing cleared for them.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [booking({ id: "bk-1", salesforce_id: LEAD_C })],
          readLeadScores: async () => asScores(new Map([[leadIdKey(LEAD_C), null]])),
          listFiring: async () => new Set(["bk-1"]),
        },
        calls,
      ),
    );
    eq(r.status === "measured" && r.compared, 0, "an absent XBC is not a comparison");
    eq(r.status === "measured" && r.unmeasured["xbc-absent"], 1, "and is counted under its own reason");
    assert(!belowLeadTierReachedVerdict(r), "no verdict off unmeasured bookings alone");
    eq(calls.resolved.length, 0, "a paged booking that became unmeasurable is NOT cleared");
  }

  // #2737: bookings from a known test source are excluded, and say so. The two
  // prefills are the shape of 2026-09-25's real bucket test bookings (a partner's
  // localhost page and the dev site), each with a real looking 00Q lead id.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [
            booking({ id: "bk-local", salesforce_id: LEAD_A, prefill: { parentOrigin: "http://localhost:3000", embed: "1" } }),
            booking({ id: "bk-dev", salesforce_id: LEAD_B, prefill: { parentOrigin: "https://dev.trypennie.com", embed: "1" } }),
          ],
          listFiring: async () => new Set(["bk-local"]),
        },
        calls,
      ),
    );
    eq(r.status, "measured", "a run holding only test source bookings is still measured");
    if (r.status === "measured") {
      eq(r.compared, 0, "no test source booking is compared");
      eq(r.testSource, 2, "each one is counted under its own name");
      eq(r.below.length, 0, "and none is a finding, whatever the lead's tier");
    }
    assert(!belowLeadTierReachedVerdict(r), "test bookings alone are never the verdict that un-parks the check");
    eq(calls.sfQueries, 0, "Salesforce is not asked about test bookings");
    eq(calls.notified.length, 0, "no page about a test booking");
    eq(calls.resolved.length, 0, "an excluded booking is not measured, so its page is not cleared as gone");
  }

  // #2728: a host that declared NO origin is recognised by the page that framed the
  // booker, through the same predicate the off site page uses, so a booking excluded
  // here is one that page names too. A production framing page is still a lead.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [
            booking({ id: "bk-framed", salesforce_id: LEAD_B, prefill: { embed: "1" }, referrer_origin: "http://localhost:3000" }),
            booking({ id: "bk-prod", salesforce_id: LEAD_A, prefill: { embed: "1" }, referrer_origin: "https://trypennie.com" }),
          ],
        },
        calls,
      ),
    );
    eq(r.status, "measured", "framing page: measured");
    if (r.status === "measured") {
      eq(r.testSource, 1, "a booking framed off site with nothing declared is a test source");
      eq(r.compared, 1, "a booking framed by production is still compared");
      eq(r.below.map((b) => b.booking.id), ["bk-prod"], "and judged as a lead");
    }
  }

  // The control the other way: a real lead's booking beside them is still compared.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const r = await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [
            booking({ id: "bk-local", salesforce_id: LEAD_B, prefill: { parentOrigin: "http://localhost:3000" } }),
            booking({ id: "bk-real", salesforce_id: LEAD_A, prefill: { parentOrigin: "https://trypennie.com" } }),
            booking({ id: "bk-api", salesforce_id: LEAD_A, prefill: null }),
          ],
        },
        calls,
      ),
    );
    eq(r.status, "measured", "measured");
    if (r.status === "measured") {
      eq(r.compared, 2, "a production origin booking and a no origin booking are both compared");
      eq(r.testSource, 1, "only the localhost one is excluded");
      eq(r.below.map((b) => b.booking.id).sort(), ["bk-api", "bk-real"], "and the real ones are judged as before");
    }
    assert(belowLeadTierReachedVerdict(r), "a real booking beside a test one still stamps");
  }

  // The silent settles: a booking now agreeing, and a booking no longer upcoming.
  // Nothing is posted for either (2026-10-07): settle sends no text at all.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    await runBelowLeadTierCheck(
      deps({ listFiring: async () => new Set(["bk-1", "bk-2", "bk-cancelled"]) }, calls),
    );
    eq(
      calls.resolved.map((r) => r.key).sort(),
      [belowLeadTierKey("bk-2"), belowLeadTierKey("bk-cancelled")],
      "the agreeing booking and the one that left the upcoming set clear; the one still below does not",
    );
    eq(calls.notified.length, 1, "and clearing posts nothing: the only send is the page for the booking still below");
  }

  // A failed firing read clears nothing, and does not stop the page.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    await runBelowLeadTierCheck(
      deps(
        {
          listFiring: async () => {
            throw new Error("alert_state read failed");
          },
        },
        calls,
      ),
    );
    eq(calls.resolved.length, 0, "no firing list, nothing cleared");
    eq(calls.notified.length, 1, "and the page still goes out");
  }

  // The catch-all read is context only: its failure never costs the page.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    await runBelowLeadTierCheck(
      deps(
        {
          loadRoutingContext: async () => {
            throw new Error("routing_decisions read failed");
          },
        },
        calls,
      ),
    );
    eq(calls.notified.length, 1, "the page is sent without the catch-all context");
    assert(/not recorded|could not be read/i.test(calls.notified[0]?.text ?? ""), "and says the context is missing");
  }

  // #2594: the arrival code read from the routing record reaches the page, so the
  // incident's shape is paged as a re-score naming the old and new codes.
  {
    const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
    const asked: string[][] = [];
    await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [
            booking({
              id: "bk-rescored",
              bucket_id: VERY_HIGH.id,
              salesforce_id: LEAD_A,
              prefill: { ...booking().prefill, [PARTNER_KEYS.submissionId]: SUB_A },
            }),
          ],
          readLeadScores: async () => new Map([[leadIdKey(LEAD_A), { code: "512", source: "submission", submissionId: SUB_A }]]),
          loadRoutingContext: async (ids) => {
            asked.push(ids);
            return new Map([["bk-rescored", { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }]]);
          },
        },
        calls,
      ),
    );
    eq(asked, [["bk-rescored"]], "the routing record is asked only about the booking being paged");
    eq(calls.notified.map((n) => n.key), [belowLeadTierKey("bk-rescored")], "one page, on the booking's own key");
    const text = calls.notified[0]?.text ?? "";
    assert(/re-scored/i.test(text) && /XBC 422 \(Very High\)/.test(text) && /XBC 512/.test(text), "naming the old and the new code");
    assert(text.includes("bk-rescored"), "and linking the booking by id");
    assert(!text.includes(LEAD_A), "the lead's Salesforce id stays out of the page");
  }

  // Salesforce is asked only about Lead ids, once per booking set, deduplicated.
  {
    const asked: string[][] = [];
    await runBelowLeadTierCheck(
      deps({
        loadBookings: async () => [
          booking({ id: "a", salesforce_id: LEAD_A }),
          booking({ id: "b", salesforce_id: LEAD_A.slice(0, 15) }),
          booking({ id: "c", salesforce_id: "pilot1234567890" }),
        ],
        readLeadScores: async (ids) => {
          asked.push(ids);
          return asScores(new Map([[leadIdKey(LEAD_A), "512"]]));
        },
      }),
    );
    eq(asked.length, 1, "one Salesforce read per run");
    eq(asked[0]?.length, 1, "the two spellings of one lead are asked about once, and the non lead id not at all");
  }

  // --- the Salesforce reader ------------------------------------------------------------
  {
    const queries: string[] = [];
    const run = async (soql: string) => {
      queries.push(soql);
      return [{ Id: LEAD_A, XBC__c: "512" }, { Id: LEAD_B, XBC__c: null }];
    };
    const got = await readLeadScores([LEAD_A.slice(0, 15), LEAD_B], run);
    eq(got.get(leadIdKey(LEAD_A))?.code, "512", "an 18 character answer lands on the 15 character question");
    eq(got.get(leadIdKey(LEAD_B))?.code, null, "a lead with no XBC is present with null, not missing");
    eq(got.has(leadIdKey(LEAD_C)), false, "a lead Salesforce did not return is missing, not null");
    assert(/FROM Lead WHERE Id IN \(/.test(queries[0] ?? ""), "it queries Lead by Id");

    const many = Array.from({ length: 900 }, (_, i) => `00QUi0000${String(i).padStart(6, "0")}AAA`);
    const chunks: string[] = [];
    await readLeadScores(many, async (soql) => {
      chunks.push(soql);
      return [];
    });
    assert(chunks.length > 1, "a long id list is split across several queries");
    assert(
      chunks.every((q) => encodeURIComponent(q).length < 16_384),
      "every query fits Salesforce's URI cap once encoded",
    );
    eq(
      chunks.reduce((n, q) => n + (q.match(/'00Q/g)?.length ?? 0), 0),
      900,
      "and every id is asked exactly once",
    );

    let threw = false;
    try {
      await readLeadScores([LEAD_A], async () => {
        throw new Error("SF query failed: 500");
      });
    } catch {
      threw = true;
    }
    assert(threw, "a failed Salesforce query THROWS rather than answering empty");

    let calledForNothing = false;
    await readLeadScores([], async () => {
      calledForNothing = true;
      return [];
    });
    assert(!calledForNothing, "no ids, no query");
  }


  // --- a recorded tier drop at confirm explains the finding, so it is counted, not paged ---
  //
  // Sales ops decided on 2026-10-02 that a lead who loses their tier's last opening
  // keeps the time they picked and drops a tier (booking d6d216f6: a cal.com
  // booking took the last High 10:30 three minutes before confirm). That is the
  // ladder working, so it must not page. Everything that is NOT that still pages,
  // and each control below is the same fixture with one fact changed (L159).
  {
    const MED_LEAD = "00QUi000010H0fpMAC";
    const fixture = (rec: Record<string, unknown> | "throw", xbc = "311") => {
      const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
      const d = deps(
        {
          loadBookings: async () => [booking({ id: "bk-drop", bucket_id: MEDIUM.id, salesforce_id: MED_LEAD })],
          readLeadScores: async (ids) => asScores(new Map(ids.map((id) => [leadIdKey(id), xbc]))),
          loadRoutingContext: async () => {
            if (rec === "throw") throw new Error("routing_decisions read failed");
            return new Map([["bk-drop", rec as never]]);
          },
        },
        calls,
      );
      return { calls, run: () => runBelowLeadTierCheck(d) };
    };
    const dropped = { catchall: false, requestedCode: "311", tierFallback: true, rungsDropped: 1 };

    {
      const { calls, run } = fixture(dropped);
      const r = await run();
      eq(calls.notified.length, 0, "a High lead dropped one tier at confirm is not paged");
      if (r.status === "measured") {
        eq(r.below.length, 0, "and is not a finding that pages");
        eq(r.explainedByTierDrop.map((f) => f.booking.id), ["bk-drop"], "it is counted as explained by the drop");
        eq(r.paged, false, "and the run says it paged nothing");
        eq(r.compared, 1, "while still counting as compared");
      }
      assert(belowLeadTierReachedVerdict(r), "an explained finding is still a measured verdict");
    }

    const stillPages: [string, Record<string, unknown> | "throw", string?][] = [
      ["no drop recorded", { ...dropped, tierFallback: false, rungsDropped: 0 }],
      ["the catch-all chose the pool", { ...dropped, catchall: true }],
      ["the lead was re-scored above the code they arrived with", dropped, "411"],
      ["the recorded drop lands somewhere other than the call's team", { ...dropped, rungsDropped: 2 }],
      ["the arrival code is unreadable", { ...dropped, requestedCode: "" }],
      ["the routing record could not be read", "throw"],
    ];
    for (const [why, rec, xbc] of stillPages) {
      const { calls, run } = fixture(rec, xbc);
      const r = await run();
      eq(calls.notified.length, 1, `still pages when ${why}`);
      if (r.status === "measured") eq(r.explainedByTierDrop.length, 0, `and is not counted as explained when ${why}`);
    }

    // A booking already firing that is now explained keeps its page state: the
    // all clear says the call moved or the score came down, which is not what
    // happened, so it waits for the call to pass (L11).
    {
      const { calls } = fixture(dropped);
      const d = deps(
        {
          loadBookings: async () => [booking({ id: "bk-drop", bucket_id: MEDIUM.id, salesforce_id: MED_LEAD })],
          readLeadScores: async (ids) => asScores(new Map(ids.map((id) => [leadIdKey(id), "311"]))),
          loadRoutingContext: async () => new Map([["bk-drop", dropped as never]]),
          listFiring: async () => new Set(["bk-drop"]),
        },
        calls,
      );
      await runBelowLeadTierCheck(d);
      eq(calls.notified.length + calls.resolved.length, 0, "an explained booking already firing is neither re-paged nor cleared");
    }
  }

  // --- #3501: judge the current submission's score, never the Lead's copy of it -------------
  //
  // The three pages between 2026-10-03 and 2026-10-07, from Salesforce's own history.
  // Two were false: Slate routed on the submission's score and the Lead record's copy
  // of it lagged. One was real: the same submission was re-scored three days later.
  {
    const LOW_111: PoolBucket = { id: "b-111", code: "111", name: "Low | Both | Legal", criteria: { debt_team: "low" } };
    const LOW_112: PoolBucket = { id: "b-112", code: "112", name: "Low | Both | Non-Legal", criteria: { debt_team: "low" } };
    const POOLS = [...BUCKETS, LOW_111, LOW_112];

    // What Salesforce held when each page fired.
    const RETURNED = "00QUi00000tHtYHMA0"; // 2026-10-07: came back, new submission scored 111
    const LAGGING = "00QUi000010OO3tMAG"; // 2026-10-03: Lead said 212 for 75 minutes
    const RESCORED = "00QUi000010PCwjMAG"; // 2026-10-06: same submission went 112 to 312
    const NO_SUB = "00QUi00000noSubAAA"; // names no submission at all
    const CORRECTED = "00QUi00000zMlRmMAK"; // 2026-09-21: Lead edited 512 to 412 49s AFTER its submission
    const leadRows: LeadFieldRecord[] = [
      { Id: CORRECTED, XBC__c: "412", Submission_Object_ID__c: "a04Ui00000MmsSrIAJ" },
      { Id: RETURNED, XBC__c: "211", Submission_Object_ID__c: "a04Ui00000NXcm1IAD" },
      { Id: LAGGING, XBC__c: "212", Submission_Object_ID__c: "a04Ui00000NL1LdIAL" },
      { Id: RESCORED, XBC__c: "312", Submission_Object_ID__c: "a04Ui00000NLKZZIA5" },
      { Id: NO_SUB, XBC__c: "312", Submission_Object_ID__c: null },
    ];
    const submissionRows: LeadFieldRecord[] = [
      { Id: "a04Ui00000NXcm1IAD", XBC_SO__c: "111", CreatedDate: "2026-10-07T18:17:53.000+0000" },
      { Id: "a04Ui00000NL1LdIAL", XBC_SO__c: "112", CreatedDate: "2026-10-03T05:07:51.000+0000" },
      { Id: "a04Ui00000NLKZZIA5", XBC_SO__c: "312", CreatedDate: "2026-10-03T11:59:08.000+0000" },
      { Id: "a04Ui00000MmsSrIAJ", XBC_SO__c: "512", CreatedDate: "2026-09-21T13:16:12.000+0000" },
    ];
    // Every XBC__c edit Salesforce recorded for these leads, as LeadHistory holds them.
    // The 2026-10-03 lead's only edit came 75 minutes AFTER its page, so when it paged
    // it had none; a lead's created value is never a history row.
    const historyRows: LeadFieldRecord[] = [
      { Id: "017h1", LeadId: RETURNED, CreatedDate: "2026-07-15T15:38:55.000+0000" },
      { Id: "017h2", LeadId: CORRECTED, CreatedDate: "2026-09-21T13:17:01.000+0000" },
      { Id: "017h3", LeadId: RESCORED, CreatedDate: "2026-10-03T11:59:53.000+0000" },
      { Id: "017h4", LeadId: RESCORED, CreatedDate: "2026-10-06T23:50:53.000+0000" },
    ];
    const queries: string[] = [];
    const salesforce = async (soql: string): Promise<LeadFieldRecord[]> => {
      queries.push(soql);
      if (/FROM Lead /.test(soql)) return leadRows.filter((r) => soql.includes(`'${r.Id}'`) || soql.includes(`'${r.Id.slice(0, 15)}'`));
      if (/FROM Submission__c /.test(soql)) return submissionRows.filter((r) => soql.includes(`'${r.Id}'`));
      if (/FROM LeadHistory /.test(soql)) return historyRows.filter((r) => soql.includes(`'${String(r.LeadId)}'`));
      throw new Error(`unexpected query: ${soql}`);
    };

    // The reader: the submission's score wins, and says where it came from.
    const scores = await readLeadScores([RETURNED, LAGGING, RESCORED, NO_SUB, CORRECTED], salesforce);
    eq(scores.get(leadIdKey(RETURNED)), { code: "111", source: "submission", submissionId: "a04Ui00000NXcm1IAD" } satisfies LeadScore, "a returning lead is scored by today's submission, not July's copy");
    eq(scores.get(leadIdKey(LAGGING))?.code, "112", "a Lead copy that has not caught up is not the score");
    eq(scores.get(leadIdKey(NO_SUB)), { code: "312", source: "lead", submissionId: null } satisfies LeadScore, "a lead naming no submission falls back to the Lead's copy, and says so");
    assert(queries.some((q) => /XBC_SO__c, CreatedDate FROM Submission__c WHERE Id IN \(/.test(q)), "it reads the named submissions");

    // Newest wins (Dan, 2026-10-07): a Lead score EDITED after the submission was made
    // is the later fact, so it wins; a copy last written before it is stale, and loses.
    eq(scores.get(leadIdKey(CORRECTED)), { code: "412", source: "lead-edit", submissionId: "a04Ui00000MmsSrIAJ" } satisfies LeadScore, "a Lead score edited after the submission wins over it");
    eq(scores.get(leadIdKey(RETURNED))?.source, "submission", "a Lead copy last edited in July loses to today's submission");
    eq(scores.get(leadIdKey(LAGGING))?.source, "submission", "a Lead copy never edited since the submission loses to it");
    {
      const history = queries.filter((q) => /FROM LeadHistory /.test(q));
      eq(history.length, 1, "the edit history is read once per run");
      assert(!history[0].includes(`'${RESCORED}'`) && !history[0].includes(`'${NO_SUB}'`), "and only for leads whose two scores disagree, so an agreeing roster costs no extra read");
      assert(/Field = 'XBC__c'/.test(history[0]), "and only for edits to the score");
    }
    // An edit whose time cannot be read, or a submission whose creation cannot, never
    // overrides the submission: the comparison could not be made.
    {
      const run = async (soql: string): Promise<LeadFieldRecord[]> => {
        if (/FROM Lead /.test(soql)) return [{ Id: LEAD_A, XBC__c: "412", Submission_Object_ID__c: "a04Ui00000subAAAAA" }];
        if (/FROM Submission__c /.test(soql)) return [{ Id: "a04Ui00000subAAAAA", XBC_SO__c: "512", CreatedDate: "not a date" }];
        return [{ Id: "017x", LeadId: LEAD_A, CreatedDate: "2026-09-21T13:17:01.000+0000" }];
      };
      eq((await readLeadScores([LEAD_A], run)).get(leadIdKey(LEAD_A))?.source, "submission", "an unreadable submission time keeps the submission");
    }

    // A named submission Salesforce did not return, or one with no score, falls back too.
    {
      const run = async (soql: string): Promise<LeadFieldRecord[]> =>
        /FROM Lead /.test(soql)
          ? [
              { Id: LEAD_A, XBC__c: "411", Submission_Object_ID__c: "a04Ui00000goneAAA" },
              { Id: LEAD_B, XBC__c: "211", Submission_Object_ID__c: "a04Ui00000blankAAA" },
            ]
          : [{ Id: "a04Ui00000blankAAA", XBC_SO__c: "  " }];
      const got = await readLeadScores([LEAD_A, LEAD_B], run);
      eq(got.get(leadIdKey(LEAD_A)), { code: "411", source: "lead", submissionId: "a04Ui00000goneAAA" } satisfies LeadScore, "a missing submission falls back to the Lead's copy");
      eq(got.get(leadIdKey(LEAD_B))?.source, "lead", "a submission with a blank score falls back to the Lead's copy");
      eq(got.has(leadIdKey(LEAD_C)), false, "a lead Salesforce did not return is missing, not a score");
    }
    // No submission named, no second query; either query refusing THROWS.
    {
      const asked: string[] = [];
      await readLeadScores([NO_SUB], async (q) => {
        asked.push(q);
        return [{ Id: NO_SUB, XBC__c: "312", Submission_Object_ID__c: null }];
      });
      eq(asked.length, 1, "no submission named, so Submission__c is never asked");
      for (const failing of [/FROM Lead /, /FROM Submission__c /, /FROM LeadHistory /]) {
        let threw = false;
        try {
          await readLeadScores([RETURNED, CORRECTED], async (q) => {
            if (failing.test(q)) throw new Error("SF query failed: 500");
            return salesforce(q);
          });
        } catch {
          threw = true;
        }
        assert(threw, `a refused ${failing.source} query throws rather than answering a partial score`);
      }
    }

    // The runner, end to end through the real reader.
    const run = async (b: UpcomingBooking[], arrival: Record<string, string>) => {
      const calls: Calls = { notified: [], resolved: [], sfQueries: 0 };
      const r = await runBelowLeadTierCheck(
        deps(
          {
            loadBookings: async () => b,
            buckets: POOLS,
            readLeadScores: (ids) => readLeadScores(ids, salesforce),
            loadRoutingContext: async (ids) =>
              new Map(ids.map((id) => [id, { catchall: false, requestedCode: arrival[id] ?? null, tierFallback: false, rungsDropped: 0 }])),
          },
          calls,
        ),
      );
      return { r, calls };
    };
    const withSub = (sub: string | null) => ({
      ...booking().prefill,
      ...(sub === null ? {} : { [PARTNER_KEYS.submissionId]: sub }),
    });

    // 2026-10-07: routed on 111, today's submission says 111. Silent.
    {
      const { r, calls } = await run(
        [booking({ id: "efdafd53", bucket_id: LOW_111.id, salesforce_id: RETURNED, prefill: withSub("a04Ui00000NXcm1IAD") })],
        { efdafd53: "111" },
      );
      eq(r.status === "measured" && r.compared, 1, "the returning lead is compared");
      eq(calls.notified.length, 0, "and NOT paged: Slate routed on the score the lead has today");
    }
    // 2026-10-03: routed on 112, the submission says 112, the Lead copy still 212. Silent.
    {
      const { calls } = await run(
        [booking({ id: "19cd927a", bucket_id: LOW_112.id, salesforce_id: LAGGING, prefill: withSub("a04Ui00000NL1LdIAL") })],
        { "19cd927a": "112" },
      );
      eq(calls.notified.length, 0, "a Lead copy that has not caught up pages nobody");
    }
    // The booking's own submission scores higher than the link's code. #3508: that is
    // EITHER a re-score after booking or a page that sent an older score (three such on
    // 2026-10-07 came from trypennie pages sending the Lead's stale copy), and Salesforce
    // keeps no history of the submission's score, so the page names both and claims neither.
    {
      const { calls } = await run(
        [booking({ id: "aafbb707", bucket_id: LOW_112.id, salesforce_id: RESCORED, prefill: withSub("a04Ui00000NLKZZIA5") })],
        { aafbb707: "112" },
      );
      eq(calls.notified.length, 1, "a booked submission scoring higher than the link still pages");
      const text = calls.notified[0]?.text ?? "";
      assert(text.startsWith("A High lead is booked with the Low team"), "naming the tier the lead has now");
      assert(/the submission they booked from scores High now/.test(text), "and saying the booked submission's score");
      assert(/either the link carried an older score or Salesforce re-scored that submission since/.test(text), "and both possible causes");
      assert(!/has since re-scored/.test(text), "and never a re-score as fact, which nothing measured");
      assert(!/submitted again/.test(text), "and not that the lead submitted again");
      assert(!/[\u2014\u2013]/.test(text) && !/NaN|undefined|null/.test(text), "no dashes or leaked values");
    }
    // A lead who submitted again after booking and scored higher: pages, as a newer submission.
    {
      const { calls } = await run(
        [booking({ id: "bk-newer", bucket_id: LOW_112.id, salesforce_id: RESCORED, prefill: withSub("a04Ui00000olderAAA") })],
        { "bk-newer": "112" },
      );
      eq(calls.notified.length, 1, "a higher newer submission pages");
      const text = calls.notified[0]?.text ?? "";
      assert(/their latest submission, newer than the one they booked from, scores High/.test(text), "saying the lead's latest submission is newer");
      assert(!/re-scored/.test(text), "and never that Salesforce re-scored them");
    }
    // A booking that recorded no submission: the cause is not known, so neither is claimed.
    {
      const { calls } = await run(
        [booking({ id: "bk-nosub", bucket_id: LOW_112.id, salesforce_id: RESCORED, prefill: withSub(null) })],
        { "bk-nosub": "112" },
      );
      const text = calls.notified[0]?.text ?? "";
      assert(/could not tell/.test(text), "a booking with no recorded submission says the check could not tell");
      assert(!/submission they booked from/.test(text) && !/newer than the one they booked from/.test(text), "and claims neither cause");
    }
    // A Lead corrected after its submission, booked on the corrected tier: silent.
    {
      const VERY_HIGH_412: PoolBucket = { id: "b-412", code: "412", name: "Very High | Both | Non-Legal", criteria: { debt_team: "very_high" } };
      POOLS.push(VERY_HIGH_412);
      const { calls } = await run(
        [booking({ id: "bk-corrected", bucket_id: VERY_HIGH_412.id, salesforce_id: CORRECTED, prefill: withSub("a04Ui00000MmsSrIAJ") })],
        { "bk-corrected": "412" },
      );
      eq(calls.notified.length, 0, "a call on the tier the Lead was corrected to pages nobody");
      // The same lead booked BELOW the correction pages, and names the Lead edit as the cause.
      const below = await run(
        [booking({ id: "bk-corrected-low", bucket_id: LOW_112.id, salesforce_id: CORRECTED, prefill: withSub("a04Ui00000MmsSrIAJ") })],
        { "bk-corrected-low": "112" },
      );
      const text = below.calls.notified[0]?.text ?? "";
      assert(/Lead record was re-scored to Very High after their latest submission/.test(text), "a rise from a Lead edit says so");
    }
    // Scored from the Lead's copy (no submission named): never claims a re-score either.
    {
      const { calls } = await run(
        [booking({ id: "bk-copy", bucket_id: LOW_112.id, salesforce_id: NO_SUB, prefill: withSub("a04Ui00000NLKZZIA5") })],
        { "bk-copy": "112" },
      );
      const text = calls.notified[0]?.text ?? "";
      assert(/could not tell/.test(text), "a score read off the Lead's copy says the check could not tell");
    }
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
