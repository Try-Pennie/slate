// The three signals for a booking API that is turning its own caller away
// (#1442, #1450, #1709). Run:
//   node --experimental-strip-types scripts/test-api-refusal-signals.ts
//
// All three are the same shape, which is why they were built together rather than
// one at a time: Slate refuses its integration, the refusal is deliberately kept
// OUT of the booking-failure share, and until now nothing said so at any volume.
//
// Why they stay out of the share. `attempts` in the #1313 window is every recorded
// outcome summed, so counting a noisy caller's refusals would put that caller's
// volume in the DENOMINATOR a real outage has to move, making the outage look
// proportionally smaller exactly while it is happening. The counting would
// actively hurt. So these are measured against their own totals instead.
//
// Each signal is judged differently, because one benign instance means something
// different in each:
//
//   ceiling      One trip is the control working. A sustained SHARE of write
//                attempts refused by our own limit means the ceiling is wrong for
//                the bot's real volume, so leads are being turned away by us.
//   credential   A rejected key has no benign explanation from OUR integration,
//                but the endpoint is public, so a single 401 is as likely to be
//                an internet scanner with a junk bearer. Judged on PERSISTENCE
//                across samples rather than on a count: a scanner's probe lands
//                in one interval, a locked-out integration refuses in every one.
//                And it counts only a bearer that was PRESENT and wrong: the
//                endpoint is public, so a request carrying no credential at all
//                is background noise that never reaches this counter.
//                A missing secret is different again and pages on the first,
//                because only our own deploy can produce it.
//   list         A single unreadable page is a blip the caller's retry clears; a
//                run of them is the bookings table unreadable, which nothing else
//                sees until the automated booker goes live and the write path
//                starts failing beside it.
import {
  judgeRefusalSignals,
  refusalSignalCopy,
  CEILING_ALERT_KEY,
  CREDENTIAL_ALERT_KEY,
  LIST_ALERT_KEY,
  type RefusalSample,
  type RefusalThresholds,
} from "../src/lib/monitor/api-refusal-signals.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 2, 15, 0, 0);

const THRESHOLDS: RefusalThresholds = {
  windowMs: 60 * MIN,
  ceilingMinRefusals: 20,
  ceilingPct: 10,
  credentialMinSamples: 3,
  listMinSamples: 3,
};

/** One 5-minute interval's measured deltas. Empty by default, so each case sets
 *  only the thing it is about and nothing leaks in from a neighbour. */
function sample(over: Partial<RefusalSample> & { atMs: number }): RefusalSample {
  return {
    attempts: 0,
    ceilingKey: 0,
    ceilingIp: 0,
    listRead: 0,
    credentialRejected: 0,
    credentialNotConfigured: 0,
    ...over,
  };
}

/** `n` consecutive 5-minute samples ending now, each built by `make`. */
function run(n: number, make: (i: number) => Partial<RefusalSample>): RefusalSample[] {
  return Array.from({ length: n }, (_, i) =>
    sample({ atMs: NOW - (n - 1 - i) * 5 * MIN, ...make(i) }),
  );
}

const judge = (samples: RefusalSample[]) =>
  judgeRefusalSignals(samples, NOW, THRESHOLDS);

// ---------------------------------------------------------------------------
// Nothing to judge is never a pass (L98)
// ---------------------------------------------------------------------------

{
  const v = judge([]);
  eq(v.ceiling.status, "unmeasured", "an empty window cannot judge the ceiling");
  eq(v.credential.status, "unmeasured", "an empty window cannot judge the credential");
  eq(v.list.status, "unmeasured", "an empty window cannot judge the list path");
}

// A window holding only samples that have AGED OUT is the same as an empty one,
// and must not be mistaken for a measured all clear.
{
  const stale = [sample({ atMs: NOW - 120 * MIN, attempts: 500 })];
  eq(judge(stale).ceiling.status, "unmeasured", "samples outside the window are not a measurement");
}

// ---------------------------------------------------------------------------
// The ceiling (#1442)
// ---------------------------------------------------------------------------

// One trip among plenty of successful attempts is the control working.
{
  const v = judge(run(12, (i) => ({ attempts: 50, ceilingKey: i === 5 ? 1 : 0 })));
  eq(v.ceiling.status, "clear", "a single trip is the ceiling doing its job, not a page");
}

// A sustained share of write attempts refused by our own limit is not.
{
  const v = judge(run(12, () => ({ attempts: 50, ceilingKey: 20 })));
  eq(v.ceiling.status, "paging", "a sustained share refused by our own ceiling pages");
  assert(v.ceiling.status === "paging" && v.ceiling.dominant === "key",
    "the page names WHICH ceiling is turning the caller away");
}

// The two ceilings mean different things (the key ceiling bounds total volume,
// the IP backstop bounds one host), so they are counted apart and the page says
// which one fired. A guard that summed them would name the wrong repair.
{
  const v = judge(run(12, () => ({ attempts: 50, ceilingIp: 20 })));
  assert(v.ceiling.status === "paging" && v.ceiling.dominant === "ip",
    "the per IP backstop is reported as itself, not as the key ceiling");
}

// The floor: a high SHARE on a tiny number of refusals is noise, exactly as the
// failure share's own minAttempts floor exists for (L139 in reverse).
{
  const v = judge(run(2, () => ({ attempts: 1, ceilingKey: 2 })));
  eq(v.ceiling.status, "clear", "a high share over a handful of refusals is below the floor");
}

// And the share has to be EXCEEDED, not merely met, matching the failure rate's
// own convention so two thresholds in one lane cannot mean different things.
{
  const exactly = judge(run(12, () => ({ attempts: 90, ceilingKey: 10 })));
  eq(exactly.ceiling.status, "clear", "a share exactly ON the threshold does not page");
  const over = judge(run(12, () => ({ attempts: 89, ceilingKey: 11 })));
  eq(over.ceiling.status, "paging", "a share above the threshold does");
}

// The refusals are NOT in `attempts` (that is the whole point), so the share has
// to be measured against attempts PLUS refusals. Measuring against attempts alone
// would report a share above 100% once the ceiling refused more than it let
// through, which is the case this exists to catch.
{
  const v = judge(run(12, () => ({ attempts: 10, ceilingKey: 90 })));
  assert(v.ceiling.status === "paging" && v.ceiling.pct <= 100,
    "the share is of everything the caller sent, so it can never exceed 100%");
  eq(v.ceiling.status === "paging" ? v.ceiling.pct : -1, 90,
    "90 refused out of 100 sent is 90%, not 900%");
}

// ---------------------------------------------------------------------------
// The credential (#1450)
// ---------------------------------------------------------------------------

// A rejected key is judged on PERSISTENCE, not on a count. The endpoint is
// public, so one 401 is as likely to be a scanner with a junk bearer as a real
// lockout, and paging on it would teach everyone to ignore the key (L36).
{
  const v = judge(run(12, (i) => ({ attempts: 50, credentialRejected: i === 4 ? 40 : 0 })));
  eq(v.credential.status, "clear",
    "forty rejections in ONE interval is a scanner, and does not page");
}

// A locked out integration refuses in every interval instead.
{
  const v = judge(run(12, (i) => ({ attempts: 0, credentialRejected: i >= 9 ? 1 : 0 })));
  eq(v.credential.status, "paging", "one rejection in each of three intervals is a lockout");
  assert(v.credential.status === "paging" && v.credential.cause === "rejected",
    "the page names the rejected key, whose repair is at the caller");
}

// Below the persistence floor it is a measured clear, not a page and not a shrug.
{
  const v = judge(run(12, (i) => ({ credentialRejected: i >= 10 ? 1 : 0 })));
  eq(v.credential.status, "clear", "two intervals is not yet persistence");
}

// A MISSING secret is a different fact with a different repair, so it is its own
// cause and it pages on the first one: only our own deploy can produce it, and
// there is no scanner that can make Slate forget its own key.
{
  const v = judge(run(12, (i) => ({ credentialNotConfigured: i === 11 ? 1 : 0 })));
  eq(v.credential.status, "paging", "a secret nobody set pages immediately");
  assert(v.credential.status === "paging" && v.credential.cause === "not_configured",
    "the page names the missing secret, whose repair is on the Worker");
}

// When both are present the missing secret wins, because it is the one that makes
// EVERY call fail and the one nobody outside Pennie could have caused.
{
  const v = judge(
    run(12, (i) => ({ credentialRejected: 1, credentialNotConfigured: i === 11 ? 1 : 0 })),
  );
  assert(v.credential.status === "paging" && v.credential.cause === "not_configured",
    "a missing secret outranks a rejected key, because it explains every call failing");
}

// ---------------------------------------------------------------------------
// The bookings list (#1709)
// ---------------------------------------------------------------------------

{
  const v = judge(run(12, (i) => ({ listRead: i === 6 ? 1 : 0 })));
  eq(v.list.status, "clear", "one unreadable page is a blip the caller's retry clears");
}
{
  const v = judge(run(12, (i) => ({ listRead: i >= 9 ? 2 : 0 })));
  eq(v.list.status, "paging", "a run of unreadable pages is the table being unreadable");
}

// The three are INDEPENDENT: a ceiling page must not drag the others with it, or
// one condition would clear three alerts and a reader could not tell what ended.
{
  const v = judge(run(12, () => ({ attempts: 50, ceilingKey: 20 })));
  eq(v.ceiling.status, "paging", "the ceiling pages");
  eq(v.credential.status, "clear", "and the credential is separately, measurably clear");
  eq(v.list.status, "clear", "and so is the list path");
}

// ---------------------------------------------------------------------------
// The copy a person reads at 3am
// ---------------------------------------------------------------------------

// Every verdict that can page must render a sentence, and every sentence must
// name what to DO: the repair for each of these is a different number in a
// different place, and "rate limited" is not something a reader can act on.
{
  const ceiling = judge(run(12, () => ({ attempts: 50, ceilingKey: 20 })));
  const text = refusalSignalCopy.ceiling(ceiling.ceiling);
  assert(text !== null, "a paging ceiling verdict renders a message");
  assert(/\d/.test(text!), "the ceiling message carries the measured numbers");
  assert(/per key|per hour|hour/i.test(text!),
    "the ceiling message names the limit that is refusing, because that is the repair");
  // With no limits supplied it names the ceiling and claims NO figure, rather
  // than falling back to one written here. A wrong number is worse than none: a
  // reader who checks it once and finds it right stops checking (L316).
  assert(!/\d+ an hour/.test(text!),
    "and claims no figure it was not given, so a stale number can never be printed");
  assert(!/^Slate\b/.test(text!), "no alert opens with the word Slate, which repeats the Slack header");
  // Written as escapes, not literals: the repo's style gate blocks any push
  // whose new lines contain a dash character, and it cannot tell the line
  // BANNING one from a line using one.
  assert(!/[\u2014\u2013]/.test(text!), "the copy carries no dash punctuation");
  assert(!/undefined|NaN|\[object Object\]/.test(text!), "the copy leaks no placeholder");
}
{
  const rejected = judge(run(12, (i) => ({ credentialRejected: i >= 9 ? 1 : 0 })));
  const missing = judge(run(12, (i) => ({ credentialNotConfigured: i === 11 ? 1 : 0 })));
  const a = refusalSignalCopy.credential(rejected.credential);
  const b = refusalSignalCopy.credential(missing.credential);
  assert(a !== null && b !== null, "both credential causes render a message");
  assert(a !== b, "the two causes read differently, because the repairs are in different places");
  assert(/caller|integration|rotat/i.test(a!), "the rejected key points at the caller's key");
  assert(/secret|deploy|Worker|configur/i.test(b!), "the missing secret points at the deployment");
}
{
  const list = judge(run(12, (i) => ({ listRead: i >= 9 ? 2 : 0 })));
  const text = refusalSignalCopy.list(list.list);
  assert(text !== null, "a paging list verdict renders a message");
  assert(/read|bookings/i.test(text!), "the list message says what could not be read");
}

// A verdict that is NOT paging renders nothing, so a caller cannot accidentally
// send an all clear worded as a page.
{
  const quiet = judge(run(12, () => ({ attempts: 50 })));
  eq(refusalSignalCopy.ceiling(quiet.ceiling), null, "a clear ceiling renders no page copy");
  eq(refusalSignalCopy.credential(quiet.credential), null, "a clear credential renders no page copy");
  eq(refusalSignalCopy.list(quiet.list), null, "a clear list path renders no page copy");
}

// The figures come from the CALLER, which reads them off the rules that actually
// refuse. Copying them into the copy builder would make the alert lie the first
// time somebody changed one (L41).
{
  const ceiling = judge(run(12, () => ({ attempts: 50, ceilingKey: 20 })));
  const withLimits = refusalSignalCopy.ceiling(ceiling.ceiling, 60 * MIN, {
    keyPerHour: 6000,
    keyPerMinute: 120,
    ipPerHour: 1200,
    ipPerMinute: 60,
  });
  assert(withLimits!.includes("6000 an hour"), "the supplied key ceiling is named");
  assert(withLimits!.includes("120 a minute"), "and its burst window");
  const ipVerdict = judge(run(12, () => ({ attempts: 50, ceilingIp: 20 })));
  const ipText = refusalSignalCopy.ceiling(ipVerdict.ceiling, 60 * MIN, {
    keyPerHour: 6000,
    keyPerMinute: 120,
    ipPerHour: 1200,
    ipPerMinute: 60,
  });
  assert(ipText!.includes("1200 an hour") && ipText!.includes("60 a minute"),
    "the IP backstop names ITS OWN figures, not the key ceiling's");
  assert(!ipText!.includes("6000"), "and never the other ceiling's, which would name the wrong repair");
}

// ---------------------------------------------------------------------------
// The keys, which are what an all clear has to be able to find again
// ---------------------------------------------------------------------------

// One constant per signal, shared by the page and its all clear, so the two can
// never drift onto different keys and leave a page nothing can clear (#1151).
const keys = [CEILING_ALERT_KEY, CREDENTIAL_ALERT_KEY, LIST_ALERT_KEY];
eq(new Set(keys).size, keys.length, "the three signals hold three distinct alert keys");
for (const k of keys) {
  assert(/^[a-z0-9_]+$/.test(k), `${k} is a plain alert_state key`);
}

finish();
