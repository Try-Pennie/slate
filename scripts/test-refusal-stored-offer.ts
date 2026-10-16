// A refused time, read against the stored row the booker serves from (#3366).
//
// On 2026-10-06 leads were refused `candidate_read_empty` nine times and re-offered
// the same times after each one, times that had been full for six to fifteen hours.
// Two layers could have served them: the stored `bucket_slots` row, or a colo's edge
// cache entry. Nothing recorded which. After such a refusal one primary key read of
// the rows now says whether the stored row still OFFERS the refused instant, and how
// old it is: yes means the row diverged from the confirm's predicate, no means the
// lead was served by something in front of the row.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-refusal-stored-offer.ts
import {
  startStoredOfferCheck,
  offeredCodes,
  storedOfferCodes,
  storedOfferFields,
  type StoredOfferDeps,
  type StoredSlotRow,
} from "../src/lib/booking/refusal-stored-offer.ts";
import type { RefusalTrace } from "../src/lib/booking/refusal-trace.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const START = "2026-10-06T17:00:00.000Z";
const NOW = Date.parse("2026-10-06T04:10:30.000Z");

const trace = (over: Partial<RefusalTrace> = {}): RefusalTrace => ({
  requestedStart: START,
  bucketCode: "112",
  stage: "candidate_read_empty",
  rungs: [{ code: "112", members: 74, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" }],
  leadId: "00QUi00000zhEUP",
  ...over,
});

const payload = (slots: string[], extra: Record<string, unknown> = {}) => ({
  bucket: { code: "112" },
  eventType: { duration_min: 20, min_notice_min: 0 },
  orgName: "Pennie",
  slots,
  ...extra,
});
const row = (code: string, slots: string[], computedAt = "2026-10-06T04:08:00.000Z", extra = {}): StoredSlotRow => ({
  bucket_code: code,
  payload: payload(slots, extra),
  computed_at: computedAt,
});

// Which refusals are checked, and which rows are read.
{
  eq(storedOfferCodes(trace()), ["112"], "a candidate_read_empty refusal reads its rung's row");
  eq(
    storedOfferCodes(trace({ rungs: [
      { code: "112", members: 74, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
      { code: "212", members: 10, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
      { code: "112", members: 74, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
    ] })),
    ["112", "212"],
    "every rung the ladder reached, once each",
  );
  eq(storedOfferCodes(trace({ rungs: [] })), ["112"], "no rungs: the requested bucket's row");
  eq(storedOfferCodes(trace({ stage: "verify_busy" })), null, "a Google refusal is not checked (the row was right to offer it)");
  eq(storedOfferCodes(trace({ stage: "race_lost" })), null, "a lost race is not checked");
  eq(storedOfferCodes(trace({ requestedStart: null })), null, "no instant: nothing to look up");
  eq(storedOfferCodes(trace({ bucketCode: null, rungs: [] })), null, "no bucket: nothing to look up");
}

// The verdict: does the stored row still offer the refused instant?
{
  const offered = storedOfferFields(trace(), [row("112", ["2026-10-06T16:50:00.000Z", "2026-10-06T17:00:00Z"])], NOW);
  eq(offered.stored_row_offers_start, true, "an instant spelled differently is still the same instant");
  eq(offered.stored_offer, "112:offered", "per rung verdict");
  eq(offered.stored_computed_at, "112:2026-10-06T04:08:00.000Z", "per rung stamp");
  eq(offered.stored_age_s, "112:150", "per rung age in seconds at the check");
  eq(offered.requested_start, START, "the instant, to join with the confirm line");
  eq(offered.bucket_code, "112", "the bucket, to join with the confirm line");
  eq(offered.lead_id, "00QUi00000zhEUP", "the external lead id, to join with the confirm line");

  const gone = storedOfferFields(trace(), [row("112", ["2026-10-06T16:50:00.000Z"])], NOW);
  eq(gone.stored_row_offers_start, false, "a row without the instant says no");
  eq(gone.stored_offer, "112:not_offered", "and says it per rung");

  const missing = storedOfferFields(trace(), [], NOW);
  eq(missing.stored_offer, "112:no_row", "a bucket with no row is said, never read as not offered");
  eq(missing.stored_row_offers_start, null, "and the overall answer is unknown, not no");

  // #3381: which path wrote the row, and whether a booking was spliced in since, per
  // rung, so an `offered` on a fresh row names the writer the divergence came from.
  eq(offered.stored_written_by, "112:-", "a row from before writers were recorded says so, never a guess");
  eq(offered.stored_spliced, "112:-", "and a row nobody spliced says that too");
  const named = storedOfferFields(
    trace(),
    [
      row("112", ["2026-10-06T16:50:00.000Z"], "2026-10-06T04:08:00.000Z", {
        writtenBy: "lane",
        splice: { seq: 2, fenceAt: "2026-10-06T04:09:00.000Z", windows: [{ atMs: Date.parse("2026-10-06T04:09:00.000Z"), fromMs: 0, lastStartMs: 1, reoffer: true }] },
      }),
    ],
    NOW,
  );
  eq(named.stored_written_by, "112:lane", "the full compute's writer, per rung");
  eq(named.stored_spliced, "112:2026-10-06T04:09:00.000Z+reoffer", "and the splice since it, a re-offer marked");
  eq(missing.stored_written_by, "112:-", "a missing row has no writer");

  const broken = storedOfferFields(trace(), [{ bucket_code: "112", payload: { nope: true }, computed_at: "x" }], NOW);
  eq(broken.stored_offer, "112:unreadable", "a malformed row is unreadable");
  eq(broken.stored_age_s, "112:-", "and an unreadable stamp has no age, never NaN");
  eq(broken.stored_row_offers_start, null, "unknown overall");

  // A Low excluding rung serves its second list (#2842), so the check reads the list
  // the lead would actually have been served from that rung.
  const t = trace({
    bucketCode: "411",
    rungs: [
      { code: "411", members: 3, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
      { code: "311", members: 9, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
    ],
  });
  const lowOnly = storedOfferFields(
    t,
    [row("411", []), row("311", [START], undefined, { slotsWithoutLow: [] })],
    NOW,
  );
  const servedOn311 = storedOfferFields(
    t,
    [row("411", []), row("311", [], undefined, { slotsWithoutLow: [START] })],
    NOW,
  );
  // Which list 311 serves to a 411 lead is the shared rule's call (servedSlotsForRung);
  // either way exactly one of these two fixtures must read as offered.
  assert(
    (lowOnly.stored_offer === "411:not_offered,311:offered") !== (servedOn311.stored_offer === "411:not_offered,311:offered"),
    `a lower rung is judged on the list it serves a lead who asked for 411 (${lowOnly.stored_offer} / ${servedOn311.stored_offer})`,
  );

  const anyRung = storedOfferFields(t, [row("411", []), row("311", [START], undefined, { slotsWithoutLow: [START] })], NOW);
  eq(anyRung.stored_row_offers_start, true, "offered on any rung is offered");
}

// Which pools a proven-stale refusal names for a refresh (#3633): exactly the rows
// that still offer the refused instant, so the confirm's own verdict decides which
// pool is recomputed, and a row that was right is left alone.
{
  eq(
    offeredCodes(trace(), [row("112", [START])]),
    ["112"],
    "a row still offering the refused instant is a pool to refresh",
  );
  eq(
    offeredCodes(trace(), [row("112", ["2026-10-06T16:50:00.000Z"])]),
    [],
    "a row that no longer offers it names no pool: it was right",
  );
  eq(
    offeredCodes(trace(), []),
    [],
    "no row is not a pool to refresh (the verdict is unknown, never stale)",
  );
  eq(
    offeredCodes(trace({ stage: "verify_busy" }), [row("112", [START])]),
    [],
    "a refusal this check is not for names no pool",
  );
  // Only the rung whose stored row still offers it, never the whole ladder.
  const t = trace({
    bucketCode: "411",
    rungs: [
      { code: "411", members: 3, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
      { code: "311", members: 9, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" },
    ],
  });
  eq(
    offeredCodes(t, [row("411", []), row("311", [START], undefined, { slotsWithoutLow: [START] })]),
    ["311"],
    "only the pool whose row still offers it is refreshed",
  );
}

// The IO: one read, a log line, a refresh of the proven-stale pool, and it never throws.
// #3796: the refresh is held for before the response, at most for the allowance the
// route hands in, and the line says which way it went.
{
  type Line = { level: string; fields: Record<string, unknown> };
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  // A timer the test fires by hand, so "the allowance ran out" is an act of the test
  // and never a real wait (L524).
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const timer: StoredOfferDeps["timer"] = (ms, fire) => {
    const t = { ms, fire, cancelled: false };
    timers.push(t);
    return () => { t.cancelled = true; };
  };
  const lines: Line[] = [];
  const reads: string[][] = [];
  const refreshed: string[] = [];
  const kept: Promise<void>[] = [];
  const deps = (
    readRows: StoredOfferDeps["readRows"],
    refreshImpl?: (code: string) => Promise<void>,
  ): StoredOfferDeps => ({
    readRows: async (codes) => { reads.push(codes); return readRows(codes); },
    nowMs: () => NOW,
    refreshPool: async (code) => { refreshed.push(code); if (refreshImpl) await refreshImpl(code); },
    keepAlive: (work) => { kept.push(work); },
    timer,
    log: {
      info: (_tag, fields) => { lines.push({ level: "info", fields }); },
      warn: (_tag, fields) => { lines.push({ level: "warn", fields }); },
    },
  });
  const reset = () => { lines.length = 0; reads.length = 0; refreshed.length = 0; kept.length = 0; timers.length = 0; };
  const offeredLines = () => lines.filter((l) => l.fields.msg === "refused time read against the stored row");
  const ALLOWANCE = 1_800;

  // Done when, first half: the refresh has RESOLVED before the response is let go.
  {
    const refresh = deferred();
    const order: string[] = [];
    const check = startStoredOfferCheck(trace(), deps(async () => [row("112", [START])], async () => {
      await refresh.promise;
      order.push("refresh resolved");
    }));
    const held = check.beforeResponse(ALLOWANCE).then(() => { order.push("response"); });
    // Let the read land and the refresh start before resolving it.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    eq(refreshed, ["112"], "the proven-stale pool's refresh is requested before the response");
    eq(order, [], "and the response is held while it runs");
    refresh.resolve();
    await held;
    eq(order, ["refresh resolved", "response"], "the refresh resolved BEFORE the response was let go");
    eq(timers.length, 1, "one wait, sized by the allowance");
    eq(timers[0].ms, ALLOWANCE, "the allowance the route handed in, no more");
    assert(timers[0].cancelled, "and the wait is cancelled once the refresh wins, so no timer is left behind");
    await check.settled;
    eq(offeredLines().length, 1, "one stored offer line");
    eq(offeredLines()[0].fields.stored_row_offers_start, true, "carrying the verdict of the read BEFORE the refresh");
    eq(offeredLines()[0].fields.refreshed_before_response, true, "and saying the refresh finished before the response");
    eq(kept.length, 1, "the whole check is kept alive past the response");
  }

  // Done when, second half: a refresh slower than the allowance still lets the
  // response go, and the refresh is still requested and carries on after it.
  {
    reset();
    const refresh = deferred();
    let refreshDone = false;
    const check = startStoredOfferCheck(trace(), deps(async () => [row("112", [START])], async () => {
      await refresh.promise;
      refreshDone = true;
    }));
    let responded = false;
    const held = check.beforeResponse(ALLOWANCE).then(() => { responded = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    eq(refreshed, ["112"], "the refresh is requested");
    assert(!responded, "the response waits while the allowance lasts");
    timers[0].fire();
    await held;
    assert(responded, "the allowance running out lets the response go");
    assert(!refreshDone, "with the refresh still running");
    eq(offeredLines().length, 1, "the line is written at the response, not after the refresh");
    eq(offeredLines()[0].fields.refreshed_before_response, false, "and says the refresh did NOT finish before it");
    eq(kept.length, 1, "the check is kept alive past the response");
    refresh.resolve();
    await kept[0];
    assert(refreshDone, "the refresh carries on and finishes after the response");
    eq(offeredLines().length, 1, "and the line is never written twice");
  }

  // An allowance already spent holds the response for nothing.
  {
    reset();
    const refresh = deferred();
    const check = startStoredOfferCheck(trace(), deps(async () => [row("112", [START])], () => refresh.promise));
    await check.beforeResponse(0);
    eq(timers.length, 0, "no wait is even scheduled with nothing left");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    eq(refreshed, ["112"], "the refresh is still requested, after the response as before #3796");
    eq(offeredLines()[0]?.fields.refreshed_before_response, false, "and the line says it raced");
    refresh.resolve();
    await check.settled;
    eq(offeredLines().length, 1, "one line");
  }

  // A refresh that FAILS inside the allowance lets the response go at once, and is not
  // reported as refreshed.
  {
    reset();
    const check = startStoredOfferCheck(
      trace(),
      deps(async () => [row("112", [START])], async () => { throw new Error("bucket_slots write refused"); }),
    );
    await check.beforeResponse(ALLOWANCE);
    eq(timers.length > 0 && !timers[0].cancelled, false, "the response is not held after the refresh failed");
    await check.settled;
    eq(offeredLines()[0].fields.refreshed_before_response, false, "a failed refresh is never reported as refreshed");
    assert(lines.some((l) => l.level === "warn"), "and its failure is said at warn");
  }

  // A row that was right asks for no refresh and holds nothing.
  {
    reset();
    const check = startStoredOfferCheck(trace(), deps(async () => [row("112", ["2026-10-06T16:50:00.000Z"])]));
    await check.beforeResponse(ALLOWANCE);
    await check.settled;
    eq(lines.length, 1, "a correct row still logs its one line");
    eq(refreshed, [], "a row that was right is never refreshed");
    eq(lines[0].fields.refreshed_before_response, null, "and no refresh was asked for, so the answer is not applicable, never false");
    assert(timers.every((t) => t.cancelled), "nothing is left waiting");
  }

  {
    reset();
    const check = startStoredOfferCheck(trace({ stage: "verify_busy" }), deps(async () => [row("112", [START])]));
    await check.beforeResponse(ALLOWANCE);
    await check.settled;
    eq(reads.length, 0, "a refusal that is not checked reads nothing");
    eq(lines.length, 0, "and logs nothing");
    eq(refreshed, [], "and refreshes nothing");
    eq(timers.length, 0, "and holds nothing");
    eq(kept.length, 0, "and keeps nothing alive");
  }

  {
    reset();
    let threw = false;
    const check = startStoredOfferCheck(trace(), deps(async () => { throw new Error("db down"); }));
    try {
      await check.beforeResponse(ALLOWANCE);
      await check.settled;
    } catch {
      threw = true;
    }
    assert(!threw, "a failed read never throws out of the check");
    eq(lines.length, 1, "it says so instead");
    eq(lines[0].level, "warn", "at warn");
    eq(lines[0].fields.stored_offer, "112:unreadable", "naming every code as unreadable, never as not offered");
    eq(lines[0].fields.stored_row_offers_start, null, "the overall answer is unknown");
    eq(refreshed, [], "an unreadable row refreshes nothing: stale was never proven");
  }

  // A SYNCHRONOUS throw from refreshPool (before it returns a promise) must be caught
  // too, not just a rejected promise, or it escapes the "never throws" contract.
  {
    reset();
    let threw = false;
    const syncThrowDeps: StoredOfferDeps = {
      ...deps(async () => [row("112", [START])]),
      refreshPool: (code) => { refreshed.push(code); throw new Error("sync boom"); },
    };
    const check = startStoredOfferCheck(trace(), syncThrowDeps);
    try {
      await check.beforeResponse(ALLOWANCE);
      await check.settled;
    } catch {
      threw = true;
    }
    assert(!threw, "a synchronous throw from the refresh never escapes the check");
    assert(lines.some((l) => l.level === "warn"), "and is said at warn like a rejection");
  }

  // The route awaits the check before its 409, so a fault nobody predicted inside it
  // (here the clock) must never reject and turn the refusal into a 500.
  {
    reset();
    let threw = false;
    const check = startStoredOfferCheck(trace(), {
      ...deps(async () => [row("112", [START])]),
      nowMs: () => { throw new Error("clock gone"); },
    });
    try {
      await check.beforeResponse(ALLOWANCE);
      await check.settled;
    } catch {
      threw = true;
    }
    assert(!threw, "an unexpected fault inside the check never rejects what the route awaits");
    eq(lines.map((l) => `${l.level}:${l.fields.msg}`), ["warn:stored offer check failed"], "it is said at warn instead");
  }
}

finish();
