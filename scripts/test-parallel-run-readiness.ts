// The judgement behind `pnpm verify:parallel-run-readiness` (#2066). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-parallel-run-readiness.ts
//
// Answering "is the shadow run trustworthy today" took a database query and eight
// issues on 2026-09-07. This is the one command that answers it, and this file pins
// the judgement over hand written facts so it is tested where no database exists.
// Two rules carry it: every way of learning nothing exits on its own code (L11,
// L98), and a run that measured nobody is never a pass.
import {
  judgeReadiness,
  READINESS_EXIT,
  READINESS_ORDER,
  type ReadinessFacts,
  type LowVolumeArmingFacts,
} from "./lib/parallel-run-readiness.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import type { CallerSeenRow } from "../src/lib/booking/caller-seen.ts";

const NOW = Date.parse("2026-09-08T16:00:00Z");
const DAY = 24 * 60 * 60_000;

/** One `api_caller_seen` row for trypennie, seen `agoMs` before NOW (#2717). */
function seen(host_kind: CallerSeenRow["host_kind"], agoMs: number, origin: string | null): CallerSeenRow {
  return { caller: "trypennie", host_kind, last_seen_at: new Date(NOW - agoMs).toISOString(), method: "GET", origin };
}

/** A healthy morning, so each case below states only what it is about. */
function healthy(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    nowMs: NOW,
    stretchedCooldowns: [],
    parity: { lastRunMs: NOW - 4 * 60 * 60_000, boundMs: 30 * 60 * 60_000, drifting: false },
    pendingBookable: [],
    calendars: { bookableAgents: 102, missingRows: [], uncovered: [] },
    emptyBuckets: { realBuckets: 60, empty: [] },
    emptyTiers: { measuredTiers: 5, empty: [] },
    unsetHours: [],
    partnerKey: { caller: "trypennie", rows: [seen("production", DAY, "https://trypennie.com")] },
    lowVolumeArming: disarmed(),
    ...over,
  };
}

/** Every Low page has recorded its source this week (#2767). */
function sourcesRecorded(): NonNullable<LowVolumeArmingFacts["pageSources"]> {
  return {
    lookbackDays: 7,
    realBookings: 40,
    unsourced: 3,
    pages: [
      { name: "Income Verification Phone Call", recorded: true },
      { name: "Completed Application Review Follow Up", recorded: true },
      { name: "Completed Application Review", recorded: true },
    ],
  };
}
function holidaysDecided(): NonNullable<LowVolumeArmingFacts["holidays"]> {
  return { windowDays: 90, checked: 3, uncovered: [] };
}
/** The arming preconditions with the alarms off, as production holds them today. */
function disarmed(over: Partial<LowVolumeArmingFacts> = {}): LowVolumeArmingFacts {
  return { armed: "disarmed", pageSources: sourcesRecorded(), holidays: holidaysDecided(), ...over };
}
function armed(over: Partial<LowVolumeArmingFacts> = {}): LowVolumeArmingFacts {
  return disarmed({ armed: "armed", ...over });
}

// --- the only pass ------------------------------------------------------------------
{
  const j = judgeReadiness(healthy());
  eq(j.exit, READINESS_EXIT.ready, "a healthy morning is ready");
  assert(/102/.test(j.summary) && /60/.test(j.summary), "and the summary says how many agents and buckets it measured");
  eq(j.findings.length, 0, "with nothing to report");
}

// --- measuring nobody is not a pass ---------------------------------------------------
{
  eq(
    judgeReadiness(healthy({ calendars: { bookableAgents: 0, missingRows: [], uncovered: [] } })).exit,
    READINESS_EXIT.nothingMeasured,
    "no bookable agents means nothing was judged",
  );
  eq(
    judgeReadiness(healthy({ emptyBuckets: { realBuckets: 0, empty: [] } })).exit,
    READINESS_EXIT.nothingMeasured,
    "no real buckets means nothing was judged",
  );
}

// --- each finding, on its own code ------------------------------------------------------
{
  const cases: [string, Partial<ReadinessFacts>, number][] = [
    ["a stretched cooldown", { stretchedCooldowns: [{ key: "empty_buckets", minutes: 10080, defaultMinutes: 360 }] }, READINESS_EXIT.alarmMuted],
    ["parity never ran", { parity: { lastRunMs: null, boundMs: 30 * 60 * 60_000, drifting: false } }, READINESS_EXIT.parityStale],
    ["parity ran too long ago", { parity: { lastRunMs: NOW - 2 * DAY, boundMs: 30 * 60 * 60_000, drifting: false } }, READINESS_EXIT.parityStale],
    ["parity is reporting drift", { parity: { lastRunMs: NOW - 60_000, boundMs: 30 * 60 * 60_000, drifting: true } }, READINESS_EXIT.parityDrifting],
    ["somebody waiting to become bookable", { pendingBookable: ["hire@x"] }, READINESS_EXIT.bookablePending],
    ["a bookable agent with no calendar row", { calendars: { bookableAgents: 102, missingRows: ["a@x"], uncovered: [] } }, READINESS_EXIT.calendarMissing],
    ["a calendar not hydrated to the horizon", { calendars: { bookableAgents: 102, missingRows: [], uncovered: ["b@x"] } }, READINESS_EXIT.calendarUncovered],
    ["an empty real bucket", { emptyBuckets: { realBuckets: 60, empty: ["120", "121", "122"] } }, READINESS_EXIT.bucketEmpty],
    // #2505: the gate was BLIND to this. `emptyBuckets` drops any code whose
    // ladder reaches a staffed rung, and every tier 5 code reaches tier 4, so a
    // completely unstaffed Ultra High used to produce exit 0 READY on the very
    // morning a pilot was being judged.
    [
      "a debt tier with nobody assigned",
      { emptyTiers: { measuredTiers: 5, empty: ["Ultra High"] } },
      READINESS_EXIT.tierEmpty,
    ],
    ["an agent on hours nobody set", { unsetHours: ["cfrank@x", "jsaminu@x"] }, READINESS_EXIT.hoursUnset],
    ["trypennie's key never seen", { partnerKey: { caller: "trypennie", rows: [] } }, READINESS_EXIT.partnerKeyUnproven],
  ];
  const seen = new Map<number, number>();
  for (const [what, over, expected] of cases) {
    const j = judgeReadiness(healthy(over));
    eq(j.exit, expected, `${what} exits on its own code`);
    assert(j.findings.length >= 1, `${what} is listed as a finding`);
    // Two cases that are the SAME finding (never ran, ran too long ago) share a
    // code on purpose; what may never happen is two different findings sharing one.
    const clash = seen.get(j.exit);
    assert(clash === undefined || clash === expected, `${what} does not share a code with a different finding`);
    seen.set(j.exit, expected);
  }
}

// --- worst first ----------------------------------------------------------------------------
// Exits on the worst finding but lists every one, so a reader is not sent to fix a
// cooldown while three buckets have nobody in them.
{
  const j = judgeReadiness(
    healthy({
      stretchedCooldowns: [{ key: "empty_buckets", minutes: 10080, defaultMinutes: 360 }],
      emptyBuckets: { realBuckets: 60, empty: ["120"] },
      pendingBookable: ["hire@x"],
    }),
  );
  eq(j.exit, READINESS_EXIT.bucketEmpty, "an empty bucket outranks a muted alarm and a pending flip");
  eq(j.findings.length, 3, "and all three are listed");
  const order = READINESS_ORDER as readonly string[];
  assert(order.indexOf("bucket-empty") < order.indexOf("alarm-muted"), "the order is the one written down");
  assert(/120/.test(j.summary), "the summary names the bucket");
}

// --- a read that failed is neither a finding nor a pass -----------------------------------
{
  const j = judgeReadiness(healthy({ emptyBuckets: null }));
  eq(j.exit, READINESS_EXIT.unreadable, "an unreadable section exits as unreadable");
  assert(/bucket/i.test(j.summary), "and names which section could not be read");
  const j2 = judgeReadiness(healthy({ stretchedCooldowns: null, emptyBuckets: { realBuckets: 60, empty: ["120"] } }));
  eq(j2.exit, READINESS_EXIT.unreadable, "unreadable outranks even a real finding, because a run that cannot see cannot vouch");
}

// --- no two outcomes share a code ------------------------------------------------------------
{
  const codes = Object.values(READINESS_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has a distinct exit code");
  assert(!(codes as number[]).includes(1), "1 is reserved for not configured, decided by the entry before any judging");
}

// --- an empty DEBT TIER outranks an empty bucket (#2505) ----------------------
//
// A bucket with nobody in it is served by the rest of its debt tier (#2486). A
// debt tier with nobody in it is served only by dropping the lead a tier, which
// is the thing a pilot is measuring, so it must name the run.
{
  const both = judgeReadiness(
    healthy({
      emptyTiers: { measuredTiers: 5, empty: ["Ultra High"] },
      emptyBuckets: { realBuckets: 60, empty: ["120"] },
    }),
  );
  eq(both.exit, READINESS_EXIT.tierEmpty, "the tier finding names the run, not the bucket one");
  assert(
    both.findings.some((f) => f.kind === "bucket-empty"),
    "and the bucket finding is still listed, so nobody is sent to fix one of two",
  );
  assert(
    both.findings[0].detail.includes("Ultra High"),
    `the worst finding names the tier in words (got: ${both.findings[0].detail})`,
  );
}

// An unreadable tier read vouches for nothing beneath it, and never reads as
// "every tier is staffed" (L215).
{
  const j = judgeReadiness(healthy({ emptyTiers: null }));
  eq(j.exit, READINESS_EXIT.unreadable, "an unreadable tier read refuses the run");
  assert(
    j.findings[0].detail.includes("debt tiers"),
    `and says which read it could not make (got: ${j.findings[0].detail})`,
  );
}

// Zero tiers measured judges nothing, exactly as zero buckets does: an empty map
// is the shape of a broken read, never a healthy roster (L98).
eq(
  judgeReadiness(healthy({ emptyTiers: { measuredTiers: 0, empty: [] } })).exit,
  READINESS_EXIT.nothingMeasured,
  "measuring no tier at all judges nothing",
);

// --- trypennie's key has authenticated from production (#2717) -------------------------
//
// Their confirmed page reads every booking with it, so a key missing from their
// production environment sends every pilot lead to a not found page, and until this
// the only way to know was to ask them. The gate may not pass on a promise: never
// seen, seen only from localhost or a preview, and seen too long ago all refuse,
// each on the same named exit and each in its own words.
{
  const never = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [] } }));
  eq(never.exit, READINESS_EXIT.partnerKeyUnproven, "never seen refuses on its own exit");
  assert(/trypennie/.test(never.summary) && /never authenticated/.test(never.summary), `and says it was never seen (got: ${never.summary})`);

  const local = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("localhost", 60_000, "http://localhost:3000")] } }));
  eq(local.exit, READINESS_EXIT.partnerKeyUnproven, "seen only from localhost refuses too");
  assert(/localhost:3000/.test(local.summary), `and names the host it was seen from (got: ${local.summary})`);

  const preview = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("other-host", 60_000, "https://tp-git-x.vercel.app")] } }));
  eq(preview.exit, READINESS_EXIT.partnerKeyUnproven, "seen only from a preview host refuses too");

  const stale = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("production", 30 * DAY, "https://trypennie.com")] } }));
  eq(stale.exit, READINESS_EXIT.partnerKeyUnproven, "seen from production a month ago refuses too");
  assert(/30 days ago/.test(stale.summary), `and says how long ago (got: ${stale.summary})`);

  const texts = new Set([never, local, preview, stale].map((j) => j.findings[0].detail));

  // Dan, 2026-09-25: a recent server call that named no host passes, because
  // trypennie's lookup is one. The summary says it passed on that.
  const server = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("unstated", DAY, null)] } }));
  eq(server.exit, READINESS_EXIT.ready, "a server call this week passes");
  assert(/server call that named no host/.test(server.summary), `and the summary says it passed on a server call (got: ${server.summary})`);
  const oldServer = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("unstated", 30 * DAY, null)] } }));
  eq(oldServer.exit, READINESS_EXIT.partnerKeyUnproven, "a server call a month ago still refuses");
  eq(texts.size, 4, "each way of not being proven reads differently");

  const prod = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [seen("production", DAY, "https://trypennie.com"), seen("localhost", 60_000, "http://localhost:3000")] } }));
  eq(prod.exit, READINESS_EXIT.ready, "seen from production this week passes, even with a later localhost test beside it");

  const unread = judgeReadiness(healthy({ partnerKey: null }));
  eq(unread.exit, READINESS_EXIT.unreadable, "an unreadable sightings table vouches for nothing, and never reads as never seen");
  assert(/partner key/.test(unread.summary), `and names what it could not read (got: ${unread.summary})`);

  const worse = judgeReadiness(healthy({ partnerKey: { caller: "trypennie", rows: [] }, emptyBuckets: { realBuckets: 60, empty: ["120"] } }));
  eq(worse.exit, READINESS_EXIT.bucketEmpty, "a bucket with nobody in it outranks the partner key");
  assert(worse.findings.some((f) => f.kind === "partner-key-unproven"), "and the key finding is still listed");
}

// --- the low volume alarms' arming preconditions (#2767) ------------------------------
//
// Two things must hold before the tier and per page alarms (#1956, #2738) are armed:
// each Low page's bookings carry their `source`, or every one records not-given and
// each page pages as one that stopped booking; and the upcoming federal holidays are
// decided in the org's exceptions, or both alarms page through a holiday (eight times
// on Labor Day 2026-09-07 in the replay). They gate ARMING, so while the alarms are off
// they are reported and never change the exit: a READY day stays READY.
{
  const missing = { ...sourcesRecorded(), pages: sourcesRecorded().pages.map((p, i) => ({ ...p, recorded: i !== 1 })) };
  const uncovered = { windowDays: 90, checked: 3, uncovered: [{ date: "2026-10-12", name: "Columbus Day" }] };

  // Disarmed: reported, never gating.
  const off = judgeReadiness(healthy({ lowVolumeArming: disarmed({ pageSources: missing, holidays: uncovered }) }));
  eq(off.exit, READINESS_EXIT.ready, "unmet arming preconditions leave a disarmed READY day READY");
  eq(off.findings.length, 0, "and are not findings");
  eq(off.advisories.map((a) => a.kind), ["page-source-missing", "holidays-uncovered"], "they are listed as arming advisories");
  assert(/before arming/i.test(off.summary) && /disarmed/.test(off.summary), `the summary says they gate arming and the alarms are off (got: ${off.summary})`);
  assert(/Completed Application Review Follow Up/.test(off.summary), "and names the page with no source");
  assert(/Columbus Day/.test(off.summary) && /2026-10-12/.test(off.summary), "and names the holiday and its date");

  const offMet = judgeReadiness(healthy());
  eq(offMet.advisories.length, 0, "met preconditions carry no advisory");
  assert(/before arming/i.test(offMet.summary) && /every federal holiday/i.test(offMet.summary), `and the READY line says they are met (got: ${offMet.summary})`);

  // Armed: each is a finding on its own code, with its own sentence.
  const src = judgeReadiness(healthy({ lowVolumeArming: armed({ pageSources: missing }) }));
  eq(src.exit, READINESS_EXIT.pageSourceMissing, "armed with a page recording no source exits on its own code");
  assert(/source/i.test(src.findings[0].detail) && /Follow Up/.test(src.findings[0].detail), `and says which page (got: ${src.findings[0].detail})`);

  const hol = judgeReadiness(healthy({ lowVolumeArming: armed({ holidays: uncovered }) }));
  eq(hol.exit, READINESS_EXIT.holidaysUncovered, "armed with an undecided holiday exits on its own code");
  assert(/Columbus Day/.test(hol.findings[0].detail) && /90 days/.test(hol.findings[0].detail), `and names the holiday and the window (got: ${hol.findings[0].detail})`);

  // No real bookings in the window: unmeasured, never a pass.
  const none = { ...sourcesRecorded(), realBookings: 0, unsourced: 0, pages: sourcesRecorded().pages.map((p) => ({ ...p, recorded: false })) };
  const unm = judgeReadiness(healthy({ lowVolumeArming: armed({ pageSources: none }) }));
  eq(unm.exit, READINESS_EXIT.pageSourceUnmeasured, "armed with no real bookings to judge is unmeasured, on its own code");
  assert(/unmeasured/i.test(unm.findings[0].detail), `and says so (got: ${unm.findings[0].detail})`);
  const unmOff = judgeReadiness(healthy({ lowVolumeArming: disarmed({ pageSources: none }) }));
  eq(unmOff.exit, READINESS_EXIT.ready, "disarmed, unmeasured does not gate either");
  eq(unmOff.advisories.map((a) => a.kind), ["page-source-unmeasured"], "and is reported as unmeasured, not as met or missing");
  assert(!/every Low page has recorded/i.test(unmOff.summary), "and never reads as met");

  const texts = new Set([src, hol, unm].map((j) => j.findings[0].detail));
  eq(texts.size, 3, "each reads differently");

  // An UNSET switch falls through to the deployment's env, which this cannot see, so
  // it gates: fail closed, and say why.
  const unset = judgeReadiness(healthy({ lowVolumeArming: disarmed({ armed: "unset", holidays: uncovered }) }));
  eq(unset.exit, READINESS_EXIT.holidaysUncovered, "an unset switch gates, because the deployment may arm it");
  assert(/unset/.test(unset.summary), `and says the switch is unset (got: ${unset.summary})`);

  // Unreadable: while armed it vouches for nothing; while disarmed it is reported, not gating.
  eq(judgeReadiness(healthy({ lowVolumeArming: armed({ holidays: null }) })).exit, READINESS_EXIT.unreadable, "armed and the holiday read failed is unreadable");
  eq(judgeReadiness(healthy({ lowVolumeArming: armed({ pageSources: null }) })).exit, READINESS_EXIT.unreadable, "armed and the source read failed is unreadable");
  const unreadSwitch = judgeReadiness(healthy({ lowVolumeArming: disarmed({ armed: null }) }));
  eq(unreadSwitch.exit, READINESS_EXIT.unreadable, "an unreadable switch is unreadable");
  // It gates, so it must never be described as disarmed (L11).
  assert(!/disarmed/.test(unreadSwitch.summary), `an unreadable switch is not called disarmed (got: ${unreadSwitch.summary})`);
  assert(/could not be read/.test(unreadSwitch.summary), `and says the switch could not be read (got: ${unreadSwitch.summary})`);
  const offUnread = judgeReadiness(healthy({ lowVolumeArming: disarmed({ holidays: null }) }));
  eq(offUnread.exit, READINESS_EXIT.ready, "disarmed, a failed precondition read does not gate");
  assert(/could not read/.test(offUnread.summary) && /holiday/.test(offUnread.summary), `and says it could not read it (got: ${offUnread.summary})`);

  // Ranked below everything that affects a lead: an empty bucket still names the run.
  const worse = judgeReadiness(healthy({ emptyBuckets: { realBuckets: 60, empty: ["120"] }, lowVolumeArming: armed({ pageSources: missing, holidays: uncovered }) }));
  eq(worse.exit, READINESS_EXIT.bucketEmpty, "an empty bucket outranks an arming precondition");
  eq(worse.findings.length, 3, "and both preconditions are still listed");
  const order = READINESS_ORDER as readonly string[];
  assert(
    order.indexOf("alarm-muted") < order.indexOf("page-source-missing") &&
      order.indexOf("page-source-missing") < order.indexOf("holidays-uncovered") &&
      order.indexOf("holidays-uncovered") < order.indexOf("page-source-unmeasured") &&
      order.indexOf("page-source-unmeasured") < order.indexOf("parity-drifting"),
    "the preconditions sit just below a muted alarm, measured ones first",
  );
}

finish();
