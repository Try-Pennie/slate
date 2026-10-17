// #1727: the embed booker's own refusals get a sustained signal. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-embed-refusal-signals.ts
//
// Three refusals on the surface real leads arrive on, each kept out of the booking
// failure share and judged on its own, on the window the booking API's refusals
// already ride (#1442):
//
//   address cap   pages on how many DISTINCT addresses the hourly cap is refusing
//   contact cap   pages on how many DISTINCT emails and phones the cap is refusing
//   honeypot      pages on a VOLUME of trips spread across several intervals
//
// The caps count keys rather than trips because one bot hammering one identity and
// many leads each tripping once produce the same volume, and only the second is our
// limit turning real people away. The floors are derived from a recorded production
// measurement, and the suite pins the shipped numbers to that derivation (L63).
import {
  EMBED_CONTACT_CAP_ALERT_KEY,
  EMBED_HONEYPOT_ALERT_KEY,
  EMBED_IP_CAP_ALERT_KEY,
  embedRefusalAllClear,
  embedRefusalCopy,
  embedTripsInWindow,
  judgeEmbedRefusalSignals,
  lockoutReadsNeeded,
  planEmbedRefusalAlerts,
  samplesFromWindow,
  type EmbedRefusalThresholds,
  type RefusalSample,
} from "../src/lib/monitor/api-refusal-signals.ts";
import {
  MEASURED_EMBED_REFUSALS,
  SHIPPED_EMBED_REFUSAL_THRESHOLDS,
  SINGLE_SOURCE_LOCKOUTS,
  deriveEmbedRefusalThresholds,
} from "../src/lib/monitor/embed-refusal-thresholds.ts";
import { lockedOutFilter } from "../src/lib/monitor/embed-lockouts.ts";
import { EMBED_REFUSAL_OUTCOME, SELF_INFLICTED_REFUSALS } from "../src/lib/monitor/booking-api-outcome.ts";
import { BOOKING_CONTACT_HOURLY_RATE_RULES, BOOKING_HOURLY_RATE_RULES } from "../src/lib/rate-limit-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 16, 15, 0, 0);
const T: EmbedRefusalThresholds = {
  windowMs: 60 * MIN,
  addressLockoutFloor: 3,
  contactLockoutFloor: 3,
  honeypotMinTrips: 6,
  honeypotMinIntervals: 3,
};

function sample(over: Partial<RefusalSample> & { atMs: number }): RefusalSample {
  return {
    attempts: 0,
    ceilingKey: 0,
    ceilingIp: 0,
    listRead: 0,
    credentialRejected: 0,
    credentialNotConfigured: 0,
    embedIpHour: 0,
    embedContactHour: 0,
    embedHoneypot: 0,
    ...over,
  };
}
const NONE = { addresses: null, contactKeys: null };

// ------------------------------------------- the floors come from a measurement

{
  eq(
    SHIPPED_EMBED_REFUSAL_THRESHOLDS,
    deriveEmbedRefusalThresholds(MEASURED_EMBED_REFUSALS, 60 * MIN),
    "the shipped floors are exactly what the recorded measurement derives",
  );
  const t = SHIPPED_EMBED_REFUSAL_THRESHOLDS;
  assert(
    t.addressLockoutFloor > SINGLE_SOURCE_LOCKOUTS.addresses,
    "one host can never page the address cap on its own",
  );
  assert(
    t.contactLockoutFloor > SINGLE_SOURCE_LOCKOUTS.contactKeys,
    "one attendee (an email and a phone) can never page the contact cap on its own",
  );
  eq(t.addressLockoutFloor, 3, "at the measured peak of 59 confirms an hour, three addresses page");
  eq(t.contactLockoutFloor, 3, "and three emails or phones");
  eq(t.honeypotMinTrips, 6, "and six honeypot trips, a tenth of the busiest hour");
  // The derivation responds to the measurement, so a re-measurement moves it: a
  // background that had reached five lockouts lifts the floor above it.
  const busier = deriveEmbedRefusalThresholds(
    { ...MEASURED_EMBED_REFUSALS, peakHourlyThrottles: { address: 5, contact: 0 }, peakHourlyHoneypot: 9 },
    60 * MIN,
  );
  eq(busier.addressLockoutFloor, 6, "positive control: a measured background of five lifts the address floor to six");
  eq(busier.honeypotMinTrips, 10, "and a measured honeypot hour of nine lifts its floor to ten");
  const bigger = deriveEmbedRefusalThresholds({ ...MEASURED_EMBED_REFUSALS, peakHourlyConfirms: 200 }, 60 * MIN);
  eq(bigger.contactLockoutFloor, 10, "and four times the traffic lifts the share floor with it");
}

// ------------------------------------- the window carries the three names

{
  // Every name the judge reads is one the share leaves out (#1725), so recording
  // them cannot dilute the failure share.
  for (const name of Object.values(EMBED_REFUSAL_OUTCOME)) {
    assert((SELF_INFLICTED_REFUSALS as readonly string[]).includes(name), `${name} is a self inflicted refusal`);
  }
  const [s] = samplesFromWindow([
    {
      atMs: NOW,
      attempts: 4,
      refusals: { refused_embed_ip_hour: 2, refused_embed_contact_hour: 3, refused_embed_honeypot: 5 },
    },
  ]);
  eq([s!.embedIpHour, s!.embedContactHour, s!.embedHoneypot], [2, 3, 5], "the window's refusal deltas reach the judge");
  const [old] = samplesFromWindow([{ atMs: NOW, attempts: 4 }]);
  eq([old!.embedIpHour, old!.embedContactHour, old!.embedHoneypot], [0, 0, 0], "a sample written before this shipped reads as none");
}

// ------------------------------------------------------------- unmeasured

{
  const v = judgeEmbedRefusalSignals([], NOW, T, NONE);
  eq(
    [v.ipCap.status, v.contactCap.status, v.honeypot.status],
    ["unmeasured", "unmeasured", "unmeasured"],
    "an empty window has not found the booker healthy, it has failed to look",
  );
  // A sample older than the window is the same as none.
  const stale = judgeEmbedRefusalSignals([sample({ atMs: NOW - 61 * MIN, embedHoneypot: 50 })], NOW, T, NONE);
  eq(stale.honeypot.status, "unmeasured", "a sample outside the window measures nothing about now");
}

// ------------------------------- a quiet window is a measured clear, no read

{
  const quiet = [sample({ atMs: NOW - 5 * MIN, attempts: 20 })];
  const trips = embedTripsInWindow(quiet, NOW, T.windowMs);
  eq(lockoutReadsNeeded(trips), { addresses: false, contactKeys: false }, "no trip, so no lockout read is spent");
  const v = judgeEmbedRefusalSignals(quiet, NOW, T, NONE);
  eq(v.ipCap, { status: "clear", trips: 0, lockedOut: 0 }, "the address cap is clear without a read");
  eq(v.contactCap, { status: "clear", trips: 0, lockedOut: 0 }, "and so is the contact cap");
  eq(v.honeypot.status, "clear", "and the honeypot");
}

// ------------------- a trip makes the read necessary, and a missing read is not a clear

{
  const tripped = [sample({ atMs: NOW - 5 * MIN, attempts: 20, embedIpHour: 1, embedContactHour: 4 })];
  const trips = embedTripsInWindow(tripped, NOW, T.windowMs);
  eq(lockoutReadsNeeded(trips), { addresses: true, contactKeys: true }, "a trip on each cap needs each read");
  // Failure path: the caller could not read the counts. That must never clear the
  // page about people who may still be locked out (#1134, #1152).
  const blind = judgeEmbedRefusalSignals(tripped, NOW, T, NONE);
  eq([blind.ipCap.status, blind.contactCap.status], ["unmeasured", "unmeasured"], "a needed read that is missing is unmeasured");
  const nan = judgeEmbedRefusalSignals(tripped, NOW, T, { addresses: Number.NaN, contactKeys: Number.NaN });
  eq([nan.ipCap.status, nan.contactCap.status], ["unmeasured", "unmeasured"], "and so is one that came back unreadable");
}

// ------------------------------------------ one bot pages nothing, many do

{
  // One bot reusing one identity: a steady run of trips in every interval, which a
  // volume check would page on. It is one key, so it pages nothing.
  const oneBot = Array.from({ length: 12 }, (_, i) => sample({ atMs: NOW - i * 5 * MIN, embedContactHour: 3 }));
  const v = judgeEmbedRefusalSignals(oneBot, NOW, T, { addresses: 0, contactKeys: 1 });
  eq(v.contactCap, { status: "clear", trips: 36, lockedOut: 1 }, "thirty six trips from one identity is the cap doing its job");
  const two = judgeEmbedRefusalSignals(oneBot, NOW, T, { addresses: 0, contactKeys: 2 });
  eq(two.contactCap.status, "clear", "an email and a phone of one bot still do not page");

  // Many leads, each tripping once: few trips, many keys.
  const leads = [sample({ atMs: NOW - 5 * MIN, embedContactHour: 3, embedIpHour: 3 })];
  const paged = judgeEmbedRefusalSignals(leads, NOW, T, { addresses: 3, contactKeys: 3 });
  eq(paged.contactCap, { status: "paging", trips: 3, lockedOut: 3, floor: 3 }, "three people locked out at once pages, at the floor");
  eq(paged.ipCap, { status: "paging", trips: 3, lockedOut: 3, floor: 3 }, "and three addresses do too");
  // Judged apart: one cap paging never drags the other.
  const apart = judgeEmbedRefusalSignals(leads, NOW, T, { addresses: 1, contactKeys: 3 });
  eq([apart.ipCap.status, apart.contactCap.status], ["clear", "paging"], "each cap is its own verdict");
}

// --------------------------------------------- the honeypot: volume and spread

{
  const burst = [sample({ atMs: NOW - 5 * MIN, embedHoneypot: 40, attempts: 10 })];
  eq(judgeEmbedRefusalSignals(burst, NOW, T, NONE).honeypot.status, "clear", "forty trips in one interval is one burst, not a campaign");
  const thin = [1, 2, 3].map((i) => sample({ atMs: NOW - i * 5 * MIN, embedHoneypot: 1 }));
  eq(judgeEmbedRefusalSignals(thin, NOW, T, NONE).honeypot.status, "clear", "three trips across three intervals is below the floor");
  const sustained = [1, 2, 3].map((i) => sample({ atMs: NOW - i * 5 * MIN, embedHoneypot: 2, attempts: 15 }));
  eq(
    judgeEmbedRefusalSignals(sustained, NOW, T, NONE).honeypot,
    { status: "paging", trips: 6, intervals: 3, attempts: 45 },
    "six trips spread across three intervals pages, and carries the attempts beside it",
  );
}

// ----------------------------------------------------------------- copy

{
  const limits = { addressPerHour: BOOKING_HOURLY_RATE_RULES[0]!.max, contactPerHour: BOOKING_CONTACT_HOURLY_RATE_RULES[0]!.max };
  eq(embedRefusalCopy.ipCap({ status: "clear", trips: 0, lockedOut: 0 }), null, "no page text for a clear address cap");
  eq(embedRefusalCopy.contactCap({ status: "unmeasured" }), null, "nor for an unmeasured contact cap");
  eq(embedRefusalCopy.honeypot({ status: "clear", trips: 1, intervals: 1 }), null, "nor for a clear honeypot");
  const texts = [
    embedRefusalCopy.ipCap({ status: "paging", trips: 14, lockedOut: 4, floor: 3 }, 60 * MIN, limits)!,
    embedRefusalCopy.contactCap({ status: "paging", trips: 9, lockedOut: 3, floor: 3 }, 60 * MIN, limits)!,
    embedRefusalCopy.honeypot({ status: "paging", trips: 12, intervals: 5, attempts: 30 }, 60 * MIN)!,
  ];
  assert(texts[0]!.includes(`${limits.addressPerHour} confirms an hour per address`), "the address page names the real limit");
  assert(texts[0]!.includes("BOOKING_HOURLY_RATE_RULES"), "and the rule to change");
  assert(texts[1]!.includes(`${limits.contactPerHour} confirms an hour per email or phone`), "the contact page names its real limit");
  assert(texts[1]!.includes("BOOKING_CONTACT_HOURLY_RATE_RULES"), "and its rule");
  assert(texts[2]!.includes("tag=booking-honeypot"), "the honeypot page says where to look");
  for (const t of [...texts, ...Object.values(embedRefusalAllClear)]) {
    assert(!/undefined|NaN|\[object Object\]|null/.test(t), `renders clean: ${t.slice(0, 50)}`);
    assert(!/^Slate\b/.test(t), "does not open with the app's own name");
  }
  eq(
    new Set([EMBED_IP_CAP_ALERT_KEY, EMBED_CONTACT_CAP_ALERT_KEY, EMBED_HONEYPOT_ALERT_KEY]).size,
    3,
    "three signals, three keys, so one ending can never clear another",
  );
}

// ------------------------------------------- what a tick sends, and never sends

{
  const limits = { addressPerHour: 10, contactPerHour: 5 };
  // The silent path (#1134, #1152): a tick that could not measure plans no all-clear,
  // whichever way it failed to measure.
  const empty = planEmbedRefusalAlerts(judgeEmbedRefusalSignals([], NOW, T, NONE), T.windowMs, limits);
  assert(empty.recovered.length === 0, "an empty window clears nothing");
  assert(empty.pages.length === 0, "and pages nothing");
  const tripped = [sample({ atMs: NOW - 5 * MIN, embedIpHour: 2, embedContactHour: 2, embedHoneypot: 0 })];
  const blind = planEmbedRefusalAlerts(judgeEmbedRefusalSignals(tripped, NOW, T, NONE), T.windowMs, limits);
  eq(
    blind.recovered.map((r) => r.key),
    [EMBED_HONEYPOT_ALERT_KEY],
    "a missing lockout read clears neither cap; only the honeypot, which needed no read, is a measured clear",
  );
  const unreadable = planEmbedRefusalAlerts(
    judgeEmbedRefusalSignals([], NOW, T, { addresses: Number.NaN, contactKeys: Number.NaN }),
    T.windowMs,
    limits,
  );
  eq(unreadable.recovered.length, 0, "an unreadable count on an empty window clears nothing either");

  // A measured clear offers all three all-clears, and a page carries its own copy.
  const quiet = planEmbedRefusalAlerts(
    judgeEmbedRefusalSignals([sample({ atMs: NOW - 5 * MIN, attempts: 9 })], NOW, T, NONE),
    T.windowMs,
    limits,
  );
  eq(
    quiet.recovered.map((r) => r.key),
    [EMBED_IP_CAP_ALERT_KEY, EMBED_CONTACT_CAP_ALERT_KEY, EMBED_HONEYPOT_ALERT_KEY],
    "positive control: a measured quiet window offers every all-clear",
  );
  const paging = planEmbedRefusalAlerts(
    judgeEmbedRefusalSignals(tripped, NOW, T, { addresses: 4, contactKeys: 1 }),
    T.windowMs,
    limits,
  );
  eq(paging.pages.map((p) => p.key), [EMBED_IP_CAP_ALERT_KEY], "a paging cap pages on its own key");
  eq(paging.pages[0]!.text, embedRefusalCopy.ipCap({ status: "paging", trips: 2, lockedOut: 4, floor: 3 }, T.windowMs, limits), "with the builder's text");
  eq(
    paging.recovered.map((r) => r.key),
    [EMBED_CONTACT_CAP_ALERT_KEY, EMBED_HONEYPOT_ALERT_KEY],
    "and the two measured clears beside it are offered, never the paging one",
  );
}

// ------------------------------------------ which limiter rows are locked out

{
  const rule = BOOKING_CONTACT_HOURLY_RATE_RULES[0]!;
  const f = lockedOutFilter(rule, NOW);
  eq(f.keyPattern, "book:contact:h:%", "every key of the contact rule, and its colon keeps a longer prefix out");
  eq(f.countAbove, rule.max, "a count above the rule's maximum was refused at least once");
  eq(f.windowStartAfterIso, new Date(NOW - rule.windowSeconds * 1000).toISOString(), "and only a live window counts");
  eq(lockedOutFilter(BOOKING_HOURLY_RATE_RULES[0]!, NOW).keyPattern, "book:h:%", "the address rule has its own pattern");
  // The two patterns cannot match each other's keys, or one cap would count the other's.
  const like = (pattern: string, key: string) => key.startsWith(pattern.replace(/%$/, "").replace(/\\(.)/g, "$1"));
  assert(!like("book:h:%", "book:contact:h:email:x"), "the address pattern does not match a contact key");
  assert(!like("book:contact:h:%", "book:h:203.0.113.1"), "and the reverse");
  eq(
    lockedOutFilter({ prefix: "a_b%", windowSeconds: 60, max: 1 }, NOW).keyPattern,
    "a\\_b\\%:%",
    "a prefix carrying a LIKE wildcard is escaped, so it matches only itself",
  );
}

finish();
