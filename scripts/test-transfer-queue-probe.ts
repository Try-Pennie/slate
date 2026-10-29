// The monitor lane's transfer queue probe (#4380). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-transfer-queue-probe.ts
//
// In business hours, every tick reads Pennie's transfer queue the way the coordinator page
// does, counts the reading against its business day, and judges two conditions:
//
//   transfer_queue_unreadable  the endpoint failed on consecutive ticks, so coordinators
//                              are offered no live transfer; only a reading that succeeds
//                              clears it.
//   transfer_queue_never_free  across the whole last business day no reading reached the
//                              threshold; judged only on a day the probe read from open to
//                              close, and cleared only by a measured reading at or above it.
//
// Pinned: when it reads (open hours only), what it records, both conditions both ways, and
// every path that measured nothing pages nobody and clears nothing (L160).
import {
  runTransferQueueProbe,
  formatTransferQueueUnreadableAlert,
  formatTransferQueueNeverFreeAlert,
  TRANSFER_QUEUE_NEVER_FREE_KEY,
  TRANSFER_QUEUE_UNREADABLE_KEY,
  type TransferQueueDayRow,
  type TransferQueueProbeDeps,
} from "../src/lib/monitor/transfer-queue-probe.ts";
import type { TransferQueueReading } from "../src/lib/coordinator/transfer-queue.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
// Monday to Friday, 8am to 8pm ET; weekends shut.
const HOURS = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 })),
  exceptions: [] as { on_date: string; is_open: boolean; start_minute: number | null; end_minute: number | null; note: string | null }[],
};
// 2026-11-17 is a Tuesday. 15:00Z is 10:00 ET; 02:00Z on the 18th is 9pm ET Tuesday.
const TUE_10AM = Date.UTC(2026, 10, 17, 15, 0, 0);
const TUE_9PM = Date.UTC(2026, 10, 18, 2, 0, 0);
const SAT_NOON = Date.UTC(2026, 10, 21, 17, 0, 0);
// Monday the 16th: open 13:00Z, close 01:00Z on the 17th.
const MON_OPEN = Date.UTC(2026, 10, 16, 13, 0, 0);
const MON_CLOSE = Date.UTC(2026, 10, 17, 1, 0, 0);

const day = (over: Partial<TransferQueueDayRow> = {}): TransferQueueDayRow => ({
  day: "2026-11-16",
  readings: 144,
  reached: 0,
  most_free: 2,
  first_read_at: new Date(MON_OPEN + 4 * 60_000).toISOString(),
  last_read_at: new Date(MON_CLOSE - 4 * 60_000).toISOString(),
  ...over,
});

function harness(over: Partial<TransferQueueProbeDeps> = {}, opts: { reading?: TransferQueueReading; rows?: TransferQueueDayRow[]; streak?: "reached" | "below" | "unknown" } = {}) {
  const sent: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  const recorded: { day: string; free: number; reached: boolean }[] = [];
  let reads = 0;
  let cleared = 0;
  let bumped = 0;
  const deps: TransferQueueProbeDeps = {
    hours: HOURS,
    nowMs: TUE_10AM,
    readQueue: async () => {
      reads++;
      return opts.reading ?? { ok: true, free: 5 };
    },
    readSettings: async () => ({ threshold: 3, line: "786-504-0671" }),
    recordReading: async (d, free, reached) => {
      recorded.push({ day: d, free, reached });
    },
    loadDays: async () => opts.rows ?? [day()],
    bumpStreak: async () => {
      bumped++;
      return opts.streak ?? "below";
    },
    clearStreak: async () => {
      cleared++;
    },
    notify: async (key, _ms, text) => {
      sent.push({ key, text });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 60_000,
    ...over,
  };
  return { deps, sent, resolved, recorded, counts: () => ({ reads, cleared, bumped }) };
}

const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

async function main() {
  // --- when it reads, and what it records ----------------------------------------------
  {
    const h = harness();
    const out = await runTransferQueueProbe(h.deps);
    eq(out.probe, { status: "read", free: 5, threshold: 3, reached: true }, "open hours: it reads the queue and judges against the stored threshold");
    eq(h.recorded, [{ day: "2026-11-17", free: 5, reached: true }], "and counts the reading against today's business day, in the org's zone");
    eq(h.counts().cleared, 1, "a reading that succeeds clears the failure streak");
    assert(keys(h.resolved).includes(TRANSFER_QUEUE_UNREADABLE_KEY), "and is the measured success that ends the unreadable condition");
  }
  {
    const h = harness({ nowMs: SAT_NOON });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.probe, { status: "closed" }, "on a shut day it does not read at all");
    eq([h.counts().reads, h.recorded.length, h.counts().bumped, h.counts().cleared], [0, 0, 0, 0], "and records, counts and clears nothing");
    eq(h.resolved.length, 0, "a shut day announces no recovery of either condition");
    assert(!keys(h.resolved).includes(TRANSFER_QUEUE_UNREADABLE_KEY), "a shut day is not a measured success");
  }
  {
    const h = harness({ nowMs: TUE_9PM });
    eq((await runTransferQueueProbe(h.deps)).probe, { status: "closed" }, "after close it does not read either");
  }
  {
    const h = harness({}, { reading: { ok: true, free: 2 } });
    await runTransferQueueProbe(h.deps);
    eq(h.recorded, [{ day: "2026-11-17", free: 2, reached: false }], "a reading under the threshold is counted as not reached");
  }

  // --- the unreadable condition ---------------------------------------------------------
  {
    const h = harness({}, { reading: { ok: false, why: "timeout", detail: "no answer within 3000ms" }, streak: "below" });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.probe, { status: "failed", why: "timeout", paged: false }, "one failure is counted and stays quiet");
    eq([h.counts().bumped, h.counts().cleared, h.recorded.length], [1, 0, 0], "it bumps the streak, clears nothing, records nothing");
    eq(h.resolved.length, 0, "a failed reading announces no recovery of either condition");
    assert(!keys(h.resolved).includes(TRANSFER_QUEUE_UNREADABLE_KEY), "and never reads as a success");
  }
  {
    const h = harness({}, { reading: { ok: false, why: "shape", detail: "answered no whole availableAgents" }, streak: "reached" });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.probe, { status: "failed", why: "shape", paged: true }, "failures on consecutive ticks page");
    assert(keys(h.sent).includes(TRANSFER_QUEUE_UNREADABLE_KEY), "on the unreadable key");
    assert(!h.sent[0]!.text.includes("availableAgents answered"), "with our own words for the reason, never the raw detail");
  }
  {
    const h = harness({}, { reading: { ok: false, why: "network", detail: "fetch failed" }, streak: "unknown" });
    await runTransferQueueProbe(h.deps);
    assert(keys(h.sent).includes(TRANSFER_QUEUE_UNREADABLE_KEY), "a streak that cannot be counted speaks rather than holding a failure it may never hear again");
  }

  // --- the never free condition ---------------------------------------------------------
  {
    const h = harness({}, { rows: [day()] });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.judgement.status, "never-free", "a whole day read from open to close, never at the threshold, pages");
    assert(keys(h.sent).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), "on the never free key");
    assert(!keys(h.resolved).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), "and clears nothing");
  }
  {
    const h = harness({}, { reading: { ok: true, free: 1 }, rows: [day({ reached: 7, most_free: 6 })] });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.judgement.status, "reached", "a day with a reading at the threshold is healthy");
    assert(keys(h.resolved).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), "and is the measured result that clears the condition");
  }
  {
    const h = harness({}, { rows: [day(), day({ day: "2026-11-17", readings: 12, reached: 2, most_free: 4, first_read_at: new Date(TUE_10AM - 60 * 60_000).toISOString(), last_read_at: new Date(TUE_10AM).toISOString() })] });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.judgement.status, "reached", "reached since the open of the last whole day counts: today's reading clears yesterday's page");
    assert(keys(h.resolved).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), "so it clears");
  }
  const unmeasured: [string, TransferQueueDayRow[]][] = [
    ["no row for the day (the probe never read it)", []],
    ["a day the probe started reading late", [day({ first_read_at: new Date(MON_OPEN + 3 * 60 * 60_000).toISOString() })]],
    ["a day the probe stopped reading early", [day({ last_read_at: new Date(MON_CLOSE - 3 * 60 * 60_000).toISOString() })]],
    ["a stamp that cannot be read", [day({ first_read_at: "not a time" })]],
  ];
  for (const [label, rows] of unmeasured) {
    const h = harness({}, { rows });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.judgement.status, "unmeasured", `${label} measures nothing`);
    assert(!keys(h.sent).includes(TRANSFER_QUEUE_NEVER_FREE_KEY) && !keys(h.resolved).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), `${label}: pages nobody and clears nothing`);
  }
  {
    const h = harness({
      loadDays: async () => {
        throw new Error("db down");
      },
    });
    let threw = false;
    try {
      await runTransferQueueProbe(h.deps);
    } catch {
      threw = true;
    }
    assert(threw, "a failed read of the days throws, so the lane's step failing streak pages a read that stays broken");
    assert(!keys(h.sent).includes(TRANSFER_QUEUE_NEVER_FREE_KEY) && !keys(h.resolved).includes(TRANSFER_QUEUE_NEVER_FREE_KEY), "and judges nothing either way");
  }
  {
    const h = harness({ nowMs: SAT_NOON }, { rows: [day({ day: "2026-11-20", first_read_at: new Date(Date.UTC(2026, 10, 20, 13, 5)).toISOString(), last_read_at: new Date(Date.UTC(2026, 10, 21, 0, 55)).toISOString() })] });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.judgement.status, "never-free", "on a shut Saturday the last whole day is Friday, judged from what was recorded then");
  }

  // --- unreadable settings ----------------------------------------------------------------
  {
    const h = harness({ readSettings: async () => null });
    const out = await runTransferQueueProbe(h.deps);
    eq(out.settingsUnreadable, true, "unreadable settings are said, so the lane's step pages a read that stays broken");
    eq(h.recorded, [], "and with no threshold to judge by, nothing is recorded");
    eq(out.probe, { status: "read", free: 5, threshold: null, reached: null }, "the reading itself still counts as the endpoint answering");
  }

  // --- the copy ---------------------------------------------------------------------------
  const page = formatTransferQueueUnreadableAlert("timeout");
  assert(/coordinators/.test(page) && /book a time/.test(page), "the unreadable page says what coordinators meet meanwhile");
  const quiet = formatTransferQueueNeverFreeAlert({ isoDate: "2026-11-16", openMs: MON_OPEN, closeMs: MON_CLOSE }, { readings: 144, mostFree: 2 }, 3);
  assert(quiet.includes("Monday, November 16") && quiet.includes("at most 2") && quiet.includes("3 or more"), `the never free page names the day, the most seen and the threshold: ${quiet}`);
  finish();
}

await main();
