// #3665: the below tier page asks whether the lead's OWN tier is free at the call's
// time, and says when the lead's recent submissions disagree on the tier. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-below-lead-tier-team-free.ts
//
// The 2026-10-13 8:20 AM ET page told a manager to "Reassign the call to somebody
// who works High leads" for booking 899afc25 (3:00 PM ET, bucket 212), while the 312
// pool offered no 3:00 PM at all, and the lead's ten submissions alternated 212 and
// 312. What this file pins:
//  - the free question is answered from the SAME served list the monitor lane's slot
//    checks read (`SlotHealth.offeredMs`), so it can never disagree with them (L107);
//  - free, not free (with a measured nearest time that day, or none), and could not
//    be checked are three different sentences, and only the measured ones claim
//    anything (L11). A time the row could not have offered (inside its notice, past
//    its last time) is "could not be checked", never "nobody is free";
//  - the submission history is read only for bookings that are about to PAGE, and a
//    failed read costs the page nothing but says it could not be read;
//  - the reader is chunked, newest first, held to a per lead count, and THROWS on a
//    truncated answer rather than counting part of a history as the whole.
import {
  belowLeadTierRepeat,
  formatBelowLeadTierAlert,
  runBelowLeadTierCheck,
  submissionAgreement,
  teamAtTime,
  type BelowFinding,
  type BelowLeadTierDeps,
  type LeadTierOffer,
  type PageFacts,
  type PoolBucket,
  type UpcomingBooking,
} from "@/lib/monitor/below-lead-tier";
import {
  leadIdKey,
  readRecentSubmissionScores,
  SUBMISSION_HISTORY_PER_LEAD,
  type LeadFieldRecord,
  type LeadScore,
} from "@/lib/salesforce/lead-xbc";
import { repeatChange, subjectsFor } from "@/lib/notify/repeat-policy";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
/** The two dash characters the copy rules forbid, built from their code points so
 *  this file holds neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
// 2026-10-13 8:20 AM ET, the page's own time.
const NOW = Date.parse("2026-10-13T12:20:00.000Z");
// 3:00 PM ET, the booked call.
const START = "2026-10-13T19:00:00.000Z";
const START_MS = Date.parse(START);
const LEAD = "00QUi00000zhEUPMA2";
const LEAD_2 = "00QUi00000abcdeFGH";

const MEDIUM_212: PoolBucket = { id: "b-212", code: "212", name: "Medium | Both | Non-Legal", criteria: { debt_team: "medium" } };
const HIGH_312: PoolBucket = { id: "b-312", code: "312", name: "High | Both | Non-Legal", criteria: { debt_team: "high" } };

function booking(over: Partial<UpcomingBooking> = {}): UpcomingBooking {
  return {
    id: "899afc25-0000-4000-8000-000000000000",
    bucket_id: MEDIUM_212.id,
    starts_at: START,
    salesforce_id: LEAD,
    external_id: null,
    agent_name: "Dana Whitfield",
    agent_email: "dana.whitfield@trypennie.com",
    prefill: { parentOrigin: "https://www.trypennie.com", embed: "1" },
    referrer_origin: "https://www.trypennie.com",
    ...over,
  };
}

const FINDING: BelowFinding = {
  kind: "below",
  booking: booking(),
  bucket: MEDIUM_212,
  pool: { rank: 2, label: "Medium" },
  lead: { kind: "tier", rank: 3, key: "high", label: "High", code: "312" },
};

/** The 312 pool as the booker serves it: 1:00 PM, 4:30 PM, and the next morning. */
const OFFER: LeadTierOffer = {
  offeredMs: [Date.parse("2026-10-13T17:00:00.000Z"), Date.parse("2026-10-13T20:30:00.000Z"), Date.parse("2026-10-14T15:00:00.000Z")],
  computedAtMs: NOW - 10 * MIN,
  minNoticeMin: 120,
};

// --- the free question -------------------------------------------------------------------
{
  eq(teamAtTime({ ...OFFER, offeredMs: [...OFFER.offeredMs!, START_MS].sort((a, b) => a - b) }, START, NOW), { kind: "free" }, "a pool offering the booked start is free");

  eq(
    teamAtTime(OFFER, START, NOW),
    { kind: "not-free", nearestMs: Date.parse("2026-10-13T20:30:00.000Z") },
    "not offered: not free, and the nearest offered time that day is named (4:30 PM beats 1:00 PM)",
  );

  // A time already past is never offered to a manager as the alternative.
  eq(
    teamAtTime(
      { ...OFFER, offeredMs: [Date.parse("2026-10-13T18:45:00.000Z"), Date.parse("2026-10-13T20:30:00.000Z"), Date.parse("2026-10-14T15:00:00.000Z")] },
      START,
      Date.parse("2026-10-13T18:50:00.000Z"),
    ),
    { kind: "not-free", nearestMs: Date.parse("2026-10-13T20:30:00.000Z") },
    "a nearer time that has already passed is not the alternative",
  );

  // Another day's time is not "that day".
  eq(
    teamAtTime({ ...OFFER, offeredMs: [Date.parse("2026-10-12T19:00:00.000Z"), Date.parse("2026-10-14T15:00:00.000Z")] }, START, NOW),
    { kind: "not-free", nearestMs: null },
    "nothing offered on the call's own ET day: not free, with no time named",
  );
  // 11:30 PM ET on the 13th is the 14th in UTC, and still the call's day.
  eq(
    teamAtTime({ ...OFFER, offeredMs: [Date.parse("2026-10-14T03:30:00.000Z"), Date.parse("2026-10-15T15:00:00.000Z")] }, START, NOW),
    { kind: "not-free", nearestMs: Date.parse("2026-10-14T03:30:00.000Z") },
    "the day is the ET day, not the UTC one",
  );

  // Every way the row cannot answer is unchecked, never "nobody is free".
  eq(teamAtTime(null, START, NOW), { kind: "unchecked", why: "no-row" }, "no stored row for the lead's code: unchecked");
  eq(teamAtTime("unreadable", START, NOW), { kind: "unchecked", why: "unreadable" }, "the shared slot read failed: unchecked");
  eq(teamAtTime({ ...OFFER, offeredMs: null }, START, NOW), { kind: "unchecked", why: "unreadable" }, "a row that could not be judged: unchecked");
  eq(teamAtTime(OFFER, "not a time", NOW), { kind: "unchecked", why: "unreadable" }, "an unreadable start: unchecked");
  eq(
    teamAtTime({ ...OFFER, computedAtMs: START_MS - 60 * MIN }, START, NOW),
    { kind: "unchecked", why: "inside-notice" },
    "a call inside the row's minimum notice could never have been offered: unchecked",
  );
  eq(teamAtTime({ ...OFFER, minNoticeMin: null }, START, NOW), { kind: "unchecked", why: "unreadable" }, "an unknown notice cannot rule the time out");
  eq(teamAtTime({ ...OFFER, computedAtMs: 0 }, START, NOW), { kind: "unchecked", why: "unreadable" }, "an unreadable computed stamp cannot rule the time out");
  eq(
    teamAtTime({ ...OFFER, offeredMs: [Date.parse("2026-10-13T13:00:00.000Z")] }, START, NOW),
    { kind: "unchecked", why: "past-horizon" },
    "a call later than every offered time may be past the row's horizon: unchecked",
  );
  eq(teamAtTime({ ...OFFER, offeredMs: [] }, START, NOW), { kind: "unchecked", why: "past-horizon" }, "a row offering nothing cannot place the call inside its horizon");
  // Offered is positive evidence, so it needs none of those guards.
  eq(teamAtTime({ offeredMs: [START_MS], computedAtMs: 0, minNoticeMin: null }, START, NOW), { kind: "free" }, "offered is free even when the guards cannot be judged");
}

// --- the submission history ----------------------------------------------------------------
{
  const flipping = ["312", "212", "312", "212", "312", "212", "312", "212", "312", "312"];
  eq(
    submissionAgreement(flipping),
    { kind: "disagree", read: 10, tiers: [{ label: "High", count: 6 }, { label: "Medium", count: 4 }] },
    "the 899afc25 lead's ten submissions disagree, counted per tier, most first",
  );
  eq(submissionAgreement(["312", "312", "311"]), { kind: "steady" }, "one tier across codes is steady");
  eq(submissionAgreement([]), { kind: "steady" }, "no submissions claims nothing");
  eq(submissionAgreement(undefined), { kind: "steady" }, "a lead the read did not return claims nothing");
  eq(
    submissionAgreement(["212", "011", "312", ""]),
    { kind: "disagree", read: 4, tiers: [{ label: "High", count: 1 }, { label: "Medium", count: 1 }] },
    "an undecodable score counts toward what was read but toward no tier; a tie lists the higher tier first",
  );
}

// --- the copy --------------------------------------------------------------------------------
const STEADY: PageFacts["history"] = { kind: "steady" };
function text(team: PageFacts["team"], history: PageFacts["history"] = STEADY, f: BelowFinding = FINDING): string {
  return formatBelowLeadTierAlert(f, { catchall: false, requestedCode: "212", tierFallback: false, rungsDropped: 0 }, "https://slate.example/b", { team, history });
}
{
  const free = text({ kind: "free" });
  assert(/Somebody on the High team is free at 3:00pm ET/.test(free), "free: the page says somebody on the lead's team is free then");
  assert(/reassign the call to them/.test(free), "and asks for the reassign");

  const notFree = text({ kind: "not-free", nearestMs: Date.parse("2026-10-13T20:30:00.000Z") });
  assert(/Nobody on the High team is free at 3:00pm ET/.test(notFree), "not free: the page says nobody on the team is free then");
  assert(/keep the call with Dana Whitfield/.test(notFree), "and offers keeping the call");
  assert(/move it to 4:30pm ET/.test(notFree), "and names the measured nearest time");
  assert(!/[Rr]eassign the call to (somebody|them)/.test(notFree), "and never asks for a reassignment that does not exist");

  const noneThatDay = text({ kind: "not-free", nearestMs: null });
  assert(/Nobody on the High team is free at 3:00pm ET or at any other time that day/.test(noneThatDay), "none that day: said plainly");
  assert(/move it to another day/.test(noneThatDay), "and the move is to another day");
  assert(!/move it to \d/.test(noneThatDay), "and no time is named that was not measured");

  const unchecked = text({ kind: "unchecked", why: "unreadable" });
  assert(/Whether anybody on the High team is free at 3:00pm ET could not be checked/.test(unchecked), "unchecked: says it could not be checked");
  assert(!/Nobody on|Somebody on/.test(unchecked), "and claims neither answer");
  for (const why of ["no-row", "inside-notice", "past-horizon"] as const) {
    eq(text({ kind: "unchecked", why }), unchecked, `every unchecked reason (${why}) reads the same to a manager: the action is the same`);
  }

  const unassigned = text({ kind: "not-free", nearestMs: null }, STEADY, { ...FINDING, booking: booking({ agent_name: null, agent_email: null }) });
  assert(/keep the call where it is/.test(unassigned), "no agent on the call: keep it where it is, not with nobody");

  const disagree = text({ kind: "free" }, { kind: "disagree", read: 10, tiers: [{ label: "High", count: 6 }, { label: "Medium", count: 4 }] });
  assert(/Of their last 10 submissions, 6 scored High and 4 Medium, so the score itself is not settled\./.test(disagree), "disagreeing submissions are named with their counts");
  const three = text({ kind: "free" }, { kind: "disagree", read: 10, tiers: [{ label: "High", count: 5 }, { label: "Medium", count: 3 }, { label: "Low", count: 2 }] });
  assert(/5 scored High, 3 Medium and 2 Low/.test(three), "three tiers read as a list");
  const historyUnread = text({ kind: "free" }, { kind: "unreadable" });
  assert(/Whether their earlier submissions agree on the tier could not be read this time\./.test(historyUnread), "an unread history says so");
  assert(!/submissions/.test(text({ kind: "free" }, { kind: "steady" })), "a steady history adds nothing");
  assert(!/submissions/.test(text({ kind: "free" }, { kind: "not-read" })), "an unasked history adds nothing");

  for (const t of [free, notFree, noneThatDay, unchecked, disagree, three, historyUnread, unassigned]) {
    assert(!DASHES.test(t), "no dashes in the page");
    assert(!/NaN|undefined|null|\[object/.test(t), "no leaked values in the page");
    assert(t.endsWith("\nhttps://slate.example/b"), "the booking link stays last");
  }
}

// --- one page per booking, never again (2026-10-26) --------------------------------------------
// Dan, 2026-10-26 15:31 ET: "I want a single ping about this per booking", choosing strictly
// once over "once, plus real moves". It replaces the same morning's rule (#4235), which posted
// again whenever a subject changed: the lead's own team being free later that day flips as
// calendars fill, so one booking posted four times in 25 minutes. The page now names no
// subjects at all, so the change only family's year long hold is the only thing that could
// post it again, and a subject a past post named leaving is never a change.
{
  eq(belowLeadTierRepeat().subjects, [], "the page names no subjects, so nothing about the booking reposts it");
  eq(belowLeadTierRepeat().band, undefined, "and carries no band that could rise");
  // Through the dispatcher's own rule, with the page's text standing in for a tick whose
  // wording moved: the subjects stay empty whatever the message says.
  const now = subjectsFor(belowLeadTierRepeat(), "the High team's nearest free time is 3:30pm ET");
  eq(now, [], "the message's changing wording never stands in for subjects");
  eq(repeatChange({ subjects: [], band: null }, now, null), null, "after the one post, no later tick is a change");
  eq(
    repeatChange(
      { subjects: [`call:${START}`, "advisor:dana.whitfield@trypennie.com", "bucket:212", "tier:high", "team:free-later-that-day"], band: null },
      now,
      null,
    ),
    null,
    "a booking already paged under #4235's subjects stays quiet too",
  );
}

// --- the runner --------------------------------------------------------------------------------
type Calls = { notified: string[]; historyAsked: string[][] };

function deps(over: Partial<BelowLeadTierDeps> = {}, calls: Calls = { notified: [], historyAsked: [] }): BelowLeadTierDeps {
  return {
    loadBookings: async () => [booking()],
    buckets: [MEDIUM_212, HIGH_312],
    readLeadScores: async (ids) => new Map(ids.map((id): [string, LeadScore] => [leadIdKey(id), { code: "312", source: "submission", submissionId: null }])),
    loadRoutingContext: async () => new Map(),
    listFiring: async () => new Set<string>(),
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    armed: true,
    notify: async (_key, _ms, t) => {
      calls.notified.push(t);
    },
    settle: async () => undefined,
    nowMs: NOW,
    leadTierOffer: (code) => (code === "312" ? OFFER : null),
    readSubmissionHistory: async (ids) => {
      calls.historyAsked.push(ids);
      return new Map([[leadIdKey(LEAD), ["312", "212", "312", "212"]]]);
    },
    ...over,
  };
}

async function main(): Promise<void> {
  // The worked case: the High pool is not free at 3:00 PM, and the score flips.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    const r = await runBelowLeadTierCheck(deps({}, calls));
    eq(r.status, "measured", "measured");
    eq(calls.notified.length, 1, "it still pages");
    const t = calls.notified[0] ?? "";
    assert(/Nobody on the High team is free at 3:00pm ET/.test(t), "the page says the High team is not free then");
    assert(/move it to 4:30pm ET/.test(t), "and names the nearest High time that day");
    assert(/Of their last 4 submissions, 2 scored High and 2 Medium/.test(t), "and that the submissions disagree");
    eq(calls.historyAsked, [[LEAD]], "the history is asked once, for the paged lead only");
    if (r.status === "measured") {
      eq(r.teamAtTime, { free: 0, "not-free": 1, unchecked: 0 }, "the result counts the team answer for the log line");
      eq(r.submissionsDisagree, 1, "and how many paged leads' submissions disagree");
    }
  }

  // The shared slot read failed this tick: the page says it could not check.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    const r = await runBelowLeadTierCheck(deps({ leadTierOffer: () => "unreadable" }, calls));
    assert(/could not be checked/.test(calls.notified[0] ?? ""), "an unreadable slot read is said, never guessed");
    eq(r.status === "measured" && r.teamAtTime.unchecked, 1, "and counted as unchecked");
  }

  // An offer lookup that throws is contained: still a page, still unchecked.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    const r = await runBelowLeadTierCheck(
      deps({ leadTierOffer: () => { throw new Error("boom"); } }, calls),
    );
    eq(r.status, "measured", "a throwing offer lookup does not fail the run");
    assert(/could not be checked/.test(calls.notified[0] ?? ""), "and the page says the team could not be checked");
  }

  // The free case still asks for the reassign.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    await runBelowLeadTierCheck(deps({ leadTierOffer: () => ({ ...OFFER, offeredMs: [START_MS, Date.parse("2026-10-14T15:00:00.000Z")] }) }, calls));
    assert(/Somebody on the High team is free at 3:00pm ET: reassign/.test(calls.notified[0] ?? ""), "a free team gets the reassign");
  }

  // A history read that fails costs the page nothing but says so.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    const r = await runBelowLeadTierCheck(
      deps({ readSubmissionHistory: async () => { throw new Error("SF 503"); } }, calls),
    );
    eq(calls.notified.length, 1, "a failed history read still pages");
    assert(/earlier submissions agree on the tier could not be read/.test(calls.notified[0] ?? ""), "and says the history could not be read");
    eq(r.status === "measured" && r.submissionsDisagree, null, "and counts nothing it did not read");
  }

  // Disarmed: nothing is paged, so Salesforce is not asked for a history nobody reads.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    const r = await runBelowLeadTierCheck(deps({ armed: false }, calls));
    eq(calls.historyAsked.length, 0, "disarmed: no history read");
    eq(r.status === "measured" && r.teamAtTime["not-free"], 1, "but the free answer, which costs no read, is still counted");
    eq(r.status === "measured" && r.submissionsDisagree, null, "and the history is unmeasured, not zero");
  }

  // No finding: no history read at all.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    await runBelowLeadTierCheck(
      deps({ readLeadScores: async (ids) => new Map(ids.map((id): [string, LeadScore] => [leadIdKey(id), { code: "212", source: "submission", submissionId: null }])) }, calls),
    );
    eq(calls.historyAsked.length, 0, "a lead in their own tier costs no history read");
  }

  // Two paged leads share one history read, and a lead it did not return claims nothing.
  {
    const calls: Calls = { notified: [], historyAsked: [] };
    await runBelowLeadTierCheck(
      deps(
        {
          loadBookings: async () => [booking(), booking({ id: "bk-2", salesforce_id: LEAD_2 }), booking({ id: "bk-3", salesforce_id: LEAD })],
        },
        calls,
      ),
    );
    eq(calls.historyAsked.length, 1, "one history read per tick");
    eq(calls.historyAsked[0]?.length, 2, "each lead asked once");
    eq(calls.notified.length, 3, "every finding still pages");
    eq(calls.notified.filter((t) => /submissions/.test(t)).length, 2, "only the lead whose history disagrees carries the sentence");
  }

  // --- the reader ---------------------------------------------------------------------------
  {
    const queries: string[] = [];
    const rows: LeadFieldRecord[] = [
      { Id: "a04A", Lead__c: LEAD, XBC_SO__c: "212", CreatedDate: "2026-10-11T12:00:00.000+0000" },
      { Id: "a04B", Lead__c: LEAD, XBC_SO__c: "312", CreatedDate: "2026-10-13T06:19:00.000+0000" },
      { Id: "a04C", Lead__c: LEAD.slice(0, 15), XBC_SO__c: null, CreatedDate: "2026-10-12T12:00:00.000+0000" },
      { Id: "a04D", Lead__c: LEAD_2, XBC_SO__c: "111", CreatedDate: "not a time" },
      { Id: "a04E", Lead__c: LEAD_2, XBC_SO__c: "211", CreatedDate: "2026-10-01T12:00:00.000+0000" },
    ];
    const got = await readRecentSubmissionScores([LEAD, LEAD_2], async (q) => {
      queries.push(q);
      return rows;
    });
    eq(got.get(leadIdKey(LEAD)), ["312", "", "212"], "newest first, keyed by the 15 character id, an empty score kept as read");
    eq(got.get(leadIdKey(LEAD_2)), ["211", "111"], "an unreadable time sorts last rather than first");
    eq(queries.length, 1, "one query for a short list");
    assert(/FROM Submission__c WHERE Lead__c IN \(/.test(queries[0] ?? ""), "it asks Submission__c by lead");
    assert(/LAST_N_DAYS:365/.test(queries[0] ?? ""), "over the last year");
    assert(/ORDER BY CreatedDate DESC LIMIT \d+/.test(queries[0] ?? ""), "newest first, with a row limit");

    const many = Array.from({ length: SUBMISSION_HISTORY_PER_LEAD + 5 }, (_, i) => ({
      Id: `a04${i}`,
      Lead__c: LEAD,
      XBC_SO__c: "312",
      CreatedDate: new Date(NOW - i * 24 * 60 * MIN).toISOString(),
    }));
    eq((await readRecentSubmissionScores([LEAD], async () => many)).get(leadIdKey(LEAD))?.length, SUBMISSION_HISTORY_PER_LEAD, "held to the per lead count");

    const ids = Array.from({ length: 900 }, (_, i) => `00QUi0000${String(i).padStart(6, "0")}AAA`);
    const chunks: string[] = [];
    await readRecentSubmissionScores(ids, async (q) => {
      chunks.push(q);
      return [];
    });
    assert(chunks.length > 1, "a long list is split");
    assert(chunks.every((q) => encodeURIComponent(q).length < 16_384), "every query fits the URI cap");
    // The row limit is shared by a query's leads, so a query holds few enough leads
    // that ordinary histories cannot reach it.
    assert(chunks.every((q) => (q.match(/'00Q/g)?.length ?? 0) <= 20), "no query asks about more than 20 leads");
    eq(chunks.reduce((n, q) => n + (q.match(/'00Q/g)?.length ?? 0), 0), 900, "and every lead is asked exactly once");

    let truncated = false;
    try {
      const limit = Number(/LIMIT (\d+)/.exec(queries[0] ?? "")?.[1]);
      await readRecentSubmissionScores([LEAD], async () =>
        Array.from({ length: limit }, (_, i) => ({ Id: `x${i}`, Lead__c: LEAD, XBC_SO__c: "312", CreatedDate: "2026-10-01T12:00:00.000+0000" })),
      );
    } catch {
      truncated = true;
    }
    assert(truncated, "an answer that reached the row limit THROWS: part of a history is not the whole");

    let threw = false;
    try {
      await readRecentSubmissionScores([LEAD], async () => {
        throw new Error("SF 500");
      });
    } catch {
      threw = true;
    }
    assert(threw, "a refused query throws");

    let asked = false;
    await readRecentSubmissionScores([], async () => {
      asked = true;
      return [];
    });
    assert(!asked, "no ids, no query");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
