// A booking whose pool sits below the lead's Salesforce tier (#2593). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-below-lead-tier.ts
//
// The rate check (`catchall_rate`) cannot see one Ultra High lead booked with the
// Low team: two bookings in twelve hundred do not move a share. So this compares
// every upcoming real booking's pool tier against the tier the lead's CURRENT
// Salesforce XBC__c decodes to, and pages per booking when the lead sits HIGHER.
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
import {
  BELOW_LEAD_TIER_KEY,
  belowLeadTierKey,
  compareBookingsToLeadTier,
  formatBelowLeadTierAlert,
  formatBelowLeadTierRecovery,
  isLeadId,
  leadIdOf,
  leadTierOf,
  poolTierOf,
  runBelowLeadTierCheck,
  type BelowLeadTierDeps,
  type PoolBucket,
  type UpcomingBooking,
} from "@/lib/monitor/below-lead-tier";
import { belowLeadTierReachedVerdict } from "@/lib/monitor/verdict-freshness";
import { readLeadXbcs, leadIdKey } from "@/lib/salesforce/lead-xbc";
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
  const withCatchall = formatBelowLeadTierAlert(finding, { catchall: true, requestedCode: "" }, "https://slate.example/admin/bookings/bk-1");
  assert(withCatchall.startsWith("An Ultra High lead"), "the page names the lead's tier, with the right article");
  assert(withCatchall.includes("Low"), "the page names the pool's tier");
  assert(withCatchall.includes("512"), "the page names the XBC Salesforce holds");
  assert(withCatchall.includes("Dana Whitfield"), "the page names the agent holding the call");
  assert(withCatchall.includes("https://slate.example/admin/bookings/bk-1"), "the page links the booking");
  assert(/catch-all chose/i.test(withCatchall), "a catch-all booking says the catch-all chose the pool");
  assert(
    !/catch-all chose/i.test(formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: null }, "u")),
    "a routed booking does not blame the catch-all",
  );
  assert(/not recorded/i.test(formatBelowLeadTierAlert(finding, null, "u")), "an unknown routing record says so rather than guessing");
  assert(/could not be read/i.test(formatBelowLeadTierAlert(finding, "unreadable", "u")), "an unreadable routing record says so");
  assert(!/[\u2014\u2013]/.test(withCatchall), "no dashes in the page");
  assert(!/NaN|undefined|null/.test(withCatchall), "no leaked values in the page");
  const rec = formatBelowLeadTierRecovery("bk-1", "agrees", "https://slate.example/admin/bookings/bk-1");
  assert(rec.includes("https://slate.example/admin/bookings/bk-1"), "the all clear links the booking it is about");
  assert(
    formatBelowLeadTierRecovery("bk-1", "gone", "u") !== formatBelowLeadTierRecovery("bk-1", "agrees", "u"),
    "a booking that left the upcoming set gets its own all clear",
  );
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
  const rescored = formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: "422" }, "u");
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
  const sameCode = formatBelowLeadTierAlert(lowFinding, { catchall: false, requestedCode: "512" }, "u");
  assert(!/re-scored/i.test(sameCode), "a lead who arrived on today's code is not called re-scored");
  assert(/XBC 512 \(Ultra High\)/.test(sameCode), "it names the code the lead arrived with");
  assert(/below the code it was given/i.test(sameCode), "and says the routing placed the call below that code");

  // An arrival code in the same tier as today's score is not a re-score either.
  const sameTier = formatBelowLeadTierAlert(lowFinding, { catchall: false, requestedCode: "501" }, "u");
  assert(!/re-scored/i.test(sameTier), "an arrival code in today's tier is never called re-scored");

  // No readable arrival code: fall back to the two possible causes, naming neither as fact.
  for (const code of [null, "", "011", "  "]) {
    const t = formatBelowLeadTierAlert(finding, { catchall: false, requestedCode: code }, "u");
    assert(!/re-scored/i.test(t) && !/below the code it was given/i.test(t), `an arrival code of ${JSON.stringify(code)} claims no cause`);
    assert(/either that code was lower/i.test(t), `and names both possibilities for ${JSON.stringify(code)}`);
    assert(!/NaN|undefined|null/.test(t), "no leaked values");
  }

  // The catch-all line wins over any arrival code: its code was blank or unreadable.
  assert(
    /catch-all chose/i.test(formatBelowLeadTierAlert(finding, { catchall: true, requestedCode: "422" }, "u")),
    "a catch-all booking says so whatever code it carried",
  );
}

// --- the runner -------------------------------------------------------------------------
type Calls = { notified: { key: string; text: string; cooldown: number }[]; resolved: { key: string; text: string }[]; sfQueries: number };

function deps(over: Partial<BelowLeadTierDeps> = {}, calls: Calls = { notified: [], resolved: [], sfQueries: 0 }): BelowLeadTierDeps {
  return {
    loadBookings: async () => [booking({ id: "bk-1", salesforce_id: LEAD_A }), booking({ id: "bk-2", bucket_id: ULTRA.id, salesforce_id: LEAD_B })],
    buckets: BUCKETS,
    readLeadXbcs: async (ids) => {
      calls.sfQueries++;
      const m = new Map<string, string | null>();
      for (const id of ids) m.set(leadIdKey(id), id === LEAD_A ? "512" : "111");
      return m;
    },
    loadRoutingContext: async () => new Map([["bk-1", { catchall: true, requestedCode: "" }]]),
    listFiring: async () => new Set<string>(),
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    armed: true,
    notify: async (key, cooldown, text) => {
      calls.notified.push({ key, text, cooldown });
    },
    resolve: async (key, text) => {
      calls.resolved.push({ key, text });
      return true;
    },
    cooldownMs: 6 * 60 * 60_000,
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
    eq(calls.notified[0]?.cooldown, 6 * 60 * 60_000, "on the configured cooldown");
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
          readLeadXbcs: async () => {
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
          readLeadXbcs: async () => new Map([[leadIdKey(LEAD_C), null]]),
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

  // The all clears: a booking now agreeing, and a booking no longer upcoming.
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
          loadBookings: async () => [booking({ id: "bk-rescored", bucket_id: VERY_HIGH.id, salesforce_id: LEAD_A })],
          loadRoutingContext: async (ids) => {
            asked.push(ids);
            return new Map([["bk-rescored", { catchall: false, requestedCode: "422" }]]);
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
        readLeadXbcs: async (ids) => {
          asked.push(ids);
          return new Map([[leadIdKey(LEAD_A), "512"]]);
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
    const got = await readLeadXbcs([LEAD_A.slice(0, 15), LEAD_B], run);
    eq(got.get(leadIdKey(LEAD_A)), "512", "an 18 character answer lands on the 15 character question");
    eq(got.get(leadIdKey(LEAD_B)), null, "a lead with no XBC is present with null, not missing");
    eq(got.has(leadIdKey(LEAD_C)), false, "a lead Salesforce did not return is missing, not null");
    assert(/FROM Lead WHERE Id IN \(/.test(queries[0] ?? ""), "it queries Lead by Id");

    const many = Array.from({ length: 900 }, (_, i) => `00QUi0000${String(i).padStart(6, "0")}AAA`);
    const chunks: string[] = [];
    await readLeadXbcs(many, async (soql) => {
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
      await readLeadXbcs([LEAD_A], async () => {
        throw new Error("SF query failed: 500");
      });
    } catch {
      threw = true;
    }
    assert(threw, "a failed Salesforce query THROWS rather than answering empty");

    let calledForNothing = false;
    await readLeadXbcs([], async () => {
      calledForNothing = true;
      return [];
    });
    assert(!calledForNothing, "no ids, no query");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
