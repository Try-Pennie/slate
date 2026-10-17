// #2377: every outcome of POST /api/bookings/cancel-duplicate, counted, and paged on a
// sustained SHARE rather than on one refusal.
//
// Drives the vocabulary (every outcome and every 503 stage has its own tally row,
// held against the route's own lists), the reading off today's tally, the two
// judgements, and every silent path: a first reading, a rollover, a window below the
// floor, a failed read.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-duplicate-cancel-rate.ts
import {
  DUPLICATE_CANCEL_OUTCOME_TALLY,
  DUPLICATE_CANCEL_REFUSED_KEY,
  DUPLICATE_CANCEL_STAGE_TALLY,
  DUPLICATE_CANCEL_TALLY_NAMES,
  DUPLICATE_CANCEL_THRESHOLDS,
  DUPLICATE_CANCEL_UNAVAILABLE_KEY,
  HANDOFF_REFUSAL_OUTCOMES,
  duplicateCancelReading,
  formatDuplicateCancelRefusedPage,
  formatDuplicateCancelUnavailablePage,
  judgeDuplicateCancel,
  runDuplicateCancelCheck,
} from "../src/lib/monitor/duplicate-cancel-rate.ts";
import {
  DUPLICATE_CANCEL_STAGES,
  DUPLICATE_OUTCOMES,
  DUPLICATE_OUTCOMES_WITH_FINDING,
} from "../src/lib/booking/duplicate-cancel.ts";
import { OUTCOME_ORDER } from "../src/lib/monitor/booking-api-outcome.ts";
import type { RateWindowState } from "../src/lib/monitor/booking-failure-rate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T = DUPLICATE_CANCEL_THRESHOLDS;
const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
const MIN = 60_000;
const DAY = "2026-10-16";

/** A window holding the given per tally name counts, spread over `ticks` samples
 *  ending at NOW, so the recent sub window sees its share of them. */
function windowOf(counts: Record<string, number>, ticks = 12, spanMs = 60 * MIN): RateWindowState {
  const samples = Array.from({ length: ticks }, (_, i) => {
    const byCode: Record<string, number> = {};
    for (const [name, n] of Object.entries(counts)) {
      const share = Math.floor(n / ticks) + (i < n % ticks ? 1 : 0);
      if (share > 0) byCode[name] = share;
    }
    const attempts = Object.values(byCode).reduce((a, b) => a + b, 0);
    const failures = Object.entries(byCode)
      .filter(([k]) => (Object.values(DUPLICATE_CANCEL_STAGE_TALLY) as string[]).includes(k))
      .reduce((a, [, b]) => a + b, 0);
    return { atMs: NOW - spanMs + Math.round(((i + 1) * spanMs) / ticks), attempts, failures, byCode };
  });
  return { day: DAY, attempts: 0, failures: 0, byCode: {}, samples };
}

const O = DUPLICATE_CANCEL_OUTCOME_TALLY;
const S = DUPLICATE_CANCEL_STAGE_TALLY;

function fakes() {
  const sent: { key: string; ms: number; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  return {
    sent,
    resolved,
    notify: async (key: string, ms: number, text: string) => {
      sent.push({ key, ms, text });
    },
    resolve: async (key: string, text: string) => {
      resolved.push({ key, text });
      return true;
    },
  };
}

async function main() {
  // --- the vocabulary: every answer the route can give has its own tally row ----------
  eq(
    Object.keys(O).sort().join(","),
    [...DUPLICATE_OUTCOMES].sort().join(","),
    "vocabulary: one tally row per outcome the database function can answer, no more and no fewer",
  );
  eq(
    Object.keys(S).sort().join(","),
    [...DUPLICATE_CANCEL_STAGES].sort().join(","),
    "vocabulary: one tally row per 503 stage",
  );
  eq(
    [...HANDOFF_REFUSAL_OUTCOMES].sort().join(","),
    [...DUPLICATE_OUTCOMES_WITH_FINDING].sort().join(","),
    "vocabulary: the refusals judged are exactly the ones that open a handoff",
  );
  eq(new Set(DUPLICATE_CANCEL_TALLY_NAMES).size, 11, "vocabulary: eleven distinct names");
  for (const name of DUPLICATE_CANCEL_TALLY_NAMES) {
    assert(
      !(OUTCOME_ORDER as readonly string[]).includes(name),
      `vocabulary: ${name} stays OUT of the booking failure share's denominator`,
    );
  }

  // --- the shipped numbers --------------------------------------------------------------
  eq(T.windowMs, 24 * 60 * MIN, "thresholds: a day of calls");
  eq(T.minCalls, 40, "thresholds: the call floor, above the whole of the measured week (30 to 38)");

  // --- the reading off today's tally ----------------------------------------------------
  {
    const r = duplicateCancelReading(DAY, {
      [O.cancelled]: 3,
      [O["no-other-call"]]: 2,
      [S.rpc]: 5,
      created: 999,
    });
    eq(r.attempts, 10, "reading: every duplicate cancel answer counts as a call");
    eq(r.failures, 5, "reading: the 503 stages are the failures");
    eq(r.byCode[S.rpc], 5, "reading: carried per name");
    eq(r.byCode.created ?? 0, 0, "reading: a booking outcome is not a duplicate cancel call");
  }

  // --- the judgement ----------------------------------------------------------------------
  {
    const v = judgeDuplicateCancel(windowOf({ [S.rpc]: 5 }), NOW, T);
    eq(v.status, "insufficient", "judge: TODAY's shape (every call a 503 at rpc, a handful a day) is below the floor");
  }
  {
    const v = judgeDuplicateCancel(windowOf({ [S.rpc]: 38 }), NOW, T);
    eq(v.status, "insufficient", "judge: even the whole measured week in one day cannot fire");
  }
  {
    const v = judgeDuplicateCancel(windowOf({ [O.cancelled]: 40, [S.rpc]: 20 }), NOW, T);
    assert(v.status === "judged" && v.unavailable.status === "breach", "judge: a third of 60 calls failing to complete pages");
    assert(v.status === "judged" && v.refused.status === "under", "judge: and the refusals are judged on their own");
  }
  {
    const v = judgeDuplicateCancel(
      windowOf({ [O.cancelled]: 30, [O["identity-conflict"]]: 15, [O["no-other-call"]]: 15 }),
      NOW,
      T,
    );
    assert(v.status === "judged" && v.refused.status === "breach", "judge: half of 60 calls refused for a person pages");
    assert(v.status === "judged" && v.unavailable.status === "under", "judge: with nothing failing to complete");
  }
  {
    // A wrong id is not a lead waiting on anybody, so it never counts as a refusal.
    const v = judgeDuplicateCancel(windowOf({ [O.cancelled]: 20, [O["not-found"]]: 40 }), NOW, T);
    assert(v.status === "judged" && v.refused.status === "under", "judge: not-found is counted but not a handoff refusal");
  }
  {
    // A share exactly on the line is not over it.
    const v = judgeDuplicateCancel(windowOf({ [O.cancelled]: 40, [S.result]: 10 }), NOW, T);
    assert(v.status === "judged" && v.unavailable.status === "under", "judge: exactly 20% is not over the line");
  }

  // --- one tick ------------------------------------------------------------------------
  async function tick(prev: RateWindowState | null, reading: Record<string, number>) {
    const f = fakes();
    let saved: RateWindowState | null = null;
    const res = await runDuplicateCancelCheck({
      nowMs: NOW,
      readToday: async () => duplicateCancelReading(DAY, reading),
      loadState: async () => prev,
      saveState: async (s) => {
        saved = s;
      },
      thresholds: T,
      cooldownMs: { refused: 1, unavailable: 2 },
      notify: f.notify,
      resolve: f.resolve,
    });
    return { res, f, saved: saved as RateWindowState | null };
  }

  {
    // The previous tick's baseline is today's totals minus this interval.
    const prev = windowOf({ [O.cancelled]: 40, [S.rpc]: 20 }, 12, 24 * 60 * MIN);
    prev.byCode = { [O.cancelled]: 40, [S.rpc]: 18 };
    prev.attempts = 58;
    prev.failures = 18;
    prev.samples = prev.samples.map((s) => ({ ...s, atMs: s.atMs - 5 * MIN }));
    const { res, f } = await tick(prev, { [O.cancelled]: 40, [S.rpc]: 20 });
    eq(res.status, "judged", "tick: a normal tick judges");
    eq(f.sent.length, 1, "tick: one page");
    eq(f.sent[0]?.key, DUPLICATE_CANCEL_UNAVAILABLE_KEY, "tick: on the unavailable key");
    eq(f.sent[0]?.ms, 2, "tick: with that key's cooldown");
    eq(f.resolved.filter((r) => r.key === DUPLICATE_CANCEL_UNAVAILABLE_KEY).length, 0, "tick: and does not clear what it paged");
  }
  {
    const { res, f } = await tick(null, { [S.rpc]: 3 });
    eq(res.status, "rebased", "first reading: no interval measured");
    eq(f.resolved.length, 0, "first reading: clears nothing");
    eq(f.sent.length, 0, "first reading: pages nothing");
  }
  {
    const prev = windowOf({ [S.rpc]: 5 });
    prev.day = "2026-10-15";
    const { res, f } = await tick(prev, { [S.rpc]: 1 });
    eq(res.status, "rebased", "rollover: no interval measured across the ET midnight");
    eq(f.resolved.length, 0, "rollover: clears nothing");
  }
  {
    // Today's real shape: a handful of calls, all failing. Below the floor, so the
    // counting runs and nothing is said in either direction.
    const prev = windowOf({ [S.rpc]: 4 });
    prev.byCode = { [S.rpc]: 4 };
    prev.attempts = 4;
    prev.failures = 4;
    const { res, f } = await tick(prev, { [S.rpc]: 5 });
    eq(res.status, "judged", "quiet: judged");
    eq(f.sent.length, 0, "quiet: today's volume cannot page");
    eq(f.resolved.length, 0, "quiet: and a day too quiet to judge clears nothing (L98)");
  }
  {
    const f = fakes();
    let threw = false;
    try {
      await runDuplicateCancelCheck({
        nowMs: NOW,
        readToday: async () => {
          throw new Error("booking_api_outcome_mix failed");
        },
        loadState: async () => null,
        saveState: async () => {},
        thresholds: T,
        cooldownMs: { refused: 1, unavailable: 2 },
        notify: f.notify,
        resolve: f.resolve,
      });
    } catch {
      threw = true;
    }
    assert(threw, "unreadable: the failed tally read reaches the step boundary");
    eq(f.resolved.length, 0, "unreadable: no all clear");
    eq(f.sent.length, 0, "unreadable: no page");
  }
  {
    // A measured clean recent run clears both keys.
    const prev = windowOf({ [O.cancelled]: 60 }, 72, 6 * 60 * MIN);
    prev.byCode = { [O.cancelled]: 60 };
    prev.attempts = 60;
    prev.samples = prev.samples.map((s) => ({ ...s, atMs: s.atMs - 5 * MIN }));
    const { f } = await tick(prev, { [O.cancelled]: 61 });
    eq(f.sent.length, 0, "clean: nothing to page");
    eq(
      f.resolved.map((r) => r.key).sort().join(","),
      [DUPLICATE_CANCEL_REFUSED_KEY, DUPLICATE_CANCEL_UNAVAILABLE_KEY].sort().join(","),
      "clean: a measured clean run clears both",
    );
  }

  // --- the words ---------------------------------------------------------------------
  {
    const page = formatDuplicateCancelUnavailablePage(
      { calls: 60, count: 20, pct: 33, byName: { [S.rpc]: 18, [S.handoff]: 2 } },
      24,
    );
    assert(page.includes("20 of 60"), "copy: names the share as counts");
    assert(page.includes("18"), "copy: names the stage counts");
    assert(!page.startsWith("Slate"), "copy: does not open with Slate");
    const refused = formatDuplicateCancelRefusedPage(
      { calls: 60, count: 30, pct: 50, byName: { [O["identity-conflict"]]: 15, [O["no-other-call"]]: 15 } },
      24,
    );
    assert(refused.includes("30 of 60"), "copy: refusals name the share as counts");
  }

  finish();
}

void main();
