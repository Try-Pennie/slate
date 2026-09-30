// What each booker OFFERS during the pilot split (#2927).
//
// A booking rate difference between the halves can come from what each system
// offered rather than from the booker, so every quarter hour the monitor lane
// records, for the Low tier, each system's earliest offered time and how many times
// it offers in the next 24 hours. The thing that must never happen is a failed read
// stored as "offered nothing": that reads as cal.com (or Slate) being empty, which is
// the one conclusion a failure cannot support (L90, L215).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-offers.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  PILOT_OFFER_INTERVAL_MS,
  pilotOfferSampleDue,
  offerSummary,
  readCalcomRoutedSlots,
  runPilotOfferSample,
  summarisePilotOffers,
  type PilotOfferRow,
} from "../src/lib/monitor/pilot-offers.ts";

const NOW = Date.parse("2026-10-01T13:00:00.000Z");
const at = (h: number, m = 0) => new Date(NOW + h * 3_600_000 + m * 60_000).toISOString();

// --- the summary of one list of offered times ---------------------------------
{
  const s = offerSummary([at(26), at(1), at(3), at(-1), at(23, 59)], NOW);
  eq(s.earliestOfferedAt, at(1), "the earliest time still ahead is the first offer");
  eq(s.offered24h, 3, "only times inside the next 24 hours are counted, past ones never");
}
{
  const s = offerSummary([], NOW);
  eq(s, { earliestOfferedAt: null, offered24h: 0 }, "a system that answered with nothing offered nothing");
}
{
  let threw = false;
  try {
    offerSummary(["not a time"], NOW);
  } catch {
    threw = true;
  }
  assert(threw, "an unreadable time is refused rather than dropped, or a broken answer would read as fewer times");
}

// --- cal.com's routed answer ---------------------------------------------------
{
  const read = readCalcomRoutedSlots(200, {
    eventTypeId: 1314152,
    slots: { "2026-10-01": [{ start: at(2) }, { start: at(1) }], "2026-10-02": [{ start: at(20) }] },
  });
  assert(read.ok, "a 200 with slots by day is read");
  if (read.ok) eq(read.times.sort(), [at(1), at(2), at(20)], "and every day's times are flattened into one list");
}
{
  const read = readCalcomRoutedSlots(200, { eventTypeId: 1314152, slots: {} });
  assert(read.ok && read.times.length === 0, "a 200 with no slots is a real answer of none");
}
{
  const refused = readCalcomRoutedSlots(429, undefined);
  eq(refused, { ok: false, reason: "cal.com answered 429" }, "a refused call is a failure with its status, never an empty offer");
  const reshaped = readCalcomRoutedSlots(200, { eventTypeId: 1314152 });
  eq(reshaped, { ok: false, reason: "cal.com answered with no slots field" }, "a reshaped answer is a failure, never an empty offer");
  const badItem = readCalcomRoutedSlots(200, { slots: { "2026-10-01": [{ begins: at(1) }] } });
  eq(badItem, { ok: false, reason: "cal.com answered a slot with no start time" }, "a slot we cannot read fails the whole reading");
}

// --- when a sample is due --------------------------------------------------------
{
  // The lane ticks every five minutes, so a quarter hour is judged with half a tick
  // of slack: without it, a tick that lands a second early waits until the next one
  // and the samples drift to every twenty minutes.
  assert(pilotOfferSampleDue(null, NOW), "with no sample yet, one is due");
  assert(!pilotOfferSampleDue(NOW - 10 * 60_000, NOW), "ten minutes after the last, not yet");
  assert(pilotOfferSampleDue(NOW - (PILOT_OFFER_INTERVAL_MS - 60_000), NOW), "a tick a minute early still samples");
  assert(pilotOfferSampleDue(NOW - 20 * 60_000, NOW), "twenty minutes after the last, due");
}

// --- one sample ------------------------------------------------------------------
function deps(over: Partial<Parameters<typeof runPilotOfferSample>[0]> = {}) {
  const inserted: PilotOfferRow[][] = [];
  const calls = { calcom: 0, slate: 0 };
  const d: Parameters<typeof runPilotOfferSample>[0] = {
    nowMs: NOW,
    bucketCode: "112",
    lastSampledAtMs: async () => null,
    readCalcom: async () => {
      calls.calcom++;
      return { status: 200, data: { eventTypeId: 1314152, slots: { d: [{ start: at(25) }, { start: at(21) }] } } };
    },
    readSlate: async () => {
      calls.slate++;
      return [at(1), at(2), at(3)];
    },
    insert: async (rows) => {
      inserted.push(rows);
    },
    ...over,
  };
  return { d, inserted, calls };
}

{
  const { d, inserted } = deps();
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "ok", slate: "ok" }, "a due sample reads both systems");
  eq(inserted.length, 1, "and writes both rows in one insert");
  const [calcom, slate] = inserted[0]!;
  eq(calcom, {
    sampled_at: new Date(NOW).toISOString(),
    system: "calcom",
    bucket_code: "112",
    ok: true,
    earliest_offered_at: at(21),
    offered_24h: 1,
    error: null,
  }, "the cal.com row carries its earliest time and its count");
  eq(slate.system, "slate", "the Slate row is the second");
  eq([slate.earliest_offered_at, slate.offered_24h], [at(1), 3], "and carries Slate's");
}
{
  const { d, inserted, calls } = deps({ lastSampledAtMs: async () => NOW - 5 * 60_000 });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: false }, "a sample taken five minutes ago means none now");
  eq([calls.calcom, calls.slate, inserted.length], [0, 0, 0], "and neither system is asked");
}
{
  const { d, inserted } = deps({
    readCalcom: async () => {
      throw new Error("fetch failed");
    },
  });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "failed", slate: "ok" }, "a cal.com outage does not stop Slate's reading");
  const calcom = inserted[0]![0]!;
  eq([calcom.ok, calcom.offered_24h, calcom.earliest_offered_at], [false, null, null], "the failure is stored as unknown, never as zero times");
  eq(calcom.error, "fetch failed", "with the reason");
}
{
  const { d, inserted } = deps({ readCalcom: async () => ({ status: 500, data: undefined }) });
  await runPilotOfferSample(d);
  eq(inserted[0]![0]!.error, "cal.com answered 500", "a refused cal.com call stores its status as the reason");
}
{
  const { d, inserted } = deps({
    readSlate: async () => {
      throw new Error("bucket 112 not found");
    },
  });
  const out = await runPilotOfferSample(d);
  eq(out, { sampled: true, calcom: "ok", slate: "failed" }, "a Slate read failure is recorded the same way");
  eq([inserted[0]![1]!.ok, inserted[0]![1]!.offered_24h], [false, null], "as unknown, never as zero");
}
{
  const { d } = deps({
    insert: async () => {
      throw new Error("insert refused");
    },
  });
  let threw = false;
  try {
    await runPilotOfferSample(d);
  } catch {
    threw = true;
  }
  assert(threw, "a sample that could not be stored throws, so the lane's step failure streak can page");
}

// --- the report's summary --------------------------------------------------------
const row = (system: "slate" | "calcom", minutes: number | null, count: number | null, sampleAt: string): PilotOfferRow => ({
  sampled_at: sampleAt,
  system,
  bucket_code: "112",
  ok: minutes !== null || count !== null,
  earliest_offered_at: minutes === null ? null : new Date(Date.parse(sampleAt) + minutes * 60_000).toISOString(),
  offered_24h: count,
  error: minutes === null && count === null ? "cal.com answered 500" : null,
});
{
  const t1 = at(0);
  const t2 = at(0, 15);
  const t3 = at(0, 30);
  const s = summarisePilotOffers([
    row("slate", 120, 200, t1),
    row("calcom", 1200, 30, t1),
    row("slate", 150, 210, t2),
    row("calcom", 60, 40, t2),
    row("slate", 90, 190, t3),
    row("calcom", null, null, t3),
  ]);
  eq(s.slate, { samples: 3, failed: 0, medianMinutesToFirst: 120, medianOffered24h: 200 }, "Slate's typical wait and count, from its readable samples");
  eq(s.calcom, { samples: 3, failed: 1, medianMinutesToFirst: 630, medianOffered24h: 35 }, "cal.com's, with the failed sample counted and left out of the medians");
  eq(s.paired, 2, "only quarter hours where BOTH systems were read are compared");
  eq(s.slateEarlier, 1, "and Slate offered the earlier time in one of those two");
}
{
  const s = summarisePilotOffers([]);
  eq([s.slate.samples, s.calcom.samples, s.paired], [0, 0, 0], "no samples is no samples");
  eq(s.slate.medianMinutesToFirst, null, "with no median rather than a zero");
}
{
  // A system that answered with nothing has no wait to measure, and must not be
  // scored as a zero minute wait (it offered NOTHING, the opposite of immediately).
  const t = at(0);
  const s = summarisePilotOffers([
    { ...row("slate", 60, 10, t) },
    { sampled_at: t, system: "calcom", bucket_code: "112", ok: true, earliest_offered_at: null, offered_24h: 0, error: null },
  ]);
  eq(s.calcom.medianOffered24h, 0, "an empty answer counts as zero times");
  eq(s.calcom.medianMinutesToFirst, null, "and has no wait to take a median of");
  eq([s.paired, s.slateEarlier], [1, 1], "a system offering something is earlier than one offering nothing");
}

finish();
