// #3137: the framing record is written from an unauthenticated path, and the Referer is
// whatever the caller sends, so the WRITE volume must not be the caller's to choose
// (L498). These drive the per isolate recorder with an injected write, scheduler and
// clock: a flood costs a bounded number of writes, a rare real host is still written at
// once, and a failed write puts its counts back rather than losing them (L368).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-frame-observe.ts
import {
  FRAME_DAY_ZONE,
  FRAME_OBSERVE_FLUSH_MS,
  FRAME_OBSERVE_MAX_KEYS,
  makeFramingRecorder,
  type FramingBatchRow,
} from "../src/lib/embed/frame-observe.ts";
import { BUSINESS_ZONE } from "../src/lib/booking/business-hours.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function rig() {
  let now = 1_000_000;
  const writes: FramingBatchRow[][] = [];
  let failNext = false;
  const deferred: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const recorder = makeFramingRecorder({
    write: async (rows) => {
      if (failNext) {
        failNext = false;
        throw new Error("db down");
      }
      writes.push(rows);
    },
    now: () => now,
    onError: (e) => errors.push(e),
  });
  return {
    record: (obs: { origin: string; surface: string }) => recorder(obs, (p) => deferred.push(p)),
    writes,
    errors,
    tick: (ms: number) => (now += ms),
    failNext: () => (failNext = true),
    settle: () => Promise.all(deferred.splice(0)),
  };
}

const total = (writes: FramingBatchRow[][], origin: string) =>
  writes.flat().filter((r) => r.origin === origin).reduce((n, r) => n + r.loads, 0);

async function main() {
  // The record's day boundary and the business day are one zone, so the database, the
  // admin page and the rest of Slate cannot disagree about which day a load landed on.
  eq(FRAME_DAY_ZONE, BUSINESS_ZONE, "the framing record keys its days in BUSINESS_ZONE");

  // A rare host is written the first time this isolate sees it.
  {
    const r = rig();
    r.record({ origin: "https://partner.example", surface: "book" });
    await r.settle();
    eq(r.writes.length, 1, "the first sighting of a host is written at once");
    eq(r.writes[0], [{ origin: "https://partner.example", surface: "book", loads: 1, capped: true }], "with its count, marked as counting against the daily cap");
  }

  // Repeat loads of a known host are batched: one write per flush window, counts kept.
  {
    const r = rig();
    for (let i = 0; i < 100; i++) r.record({ origin: "https://www.trypennie.com", surface: "book" });
    await r.settle();
    eq(r.writes.length, 1, "a hundred loads of one host inside the window: one write");
    r.tick(FRAME_OBSERVE_FLUSH_MS);
    r.record({ origin: "https://www.trypennie.com", surface: "book" });
    await r.settle();
    eq(r.writes.length, 2, "the next load after the window flushes the batch");
    eq(total(r.writes, "https://www.trypennie.com"), 101, "and no load is lost or counted twice");
    assert(r.writes.flat().every((w) => w.capped === false), "an allow list host never counts against the cap");
  }

  // A flood of forged origins costs a bounded number of writes and bounded memory.
  {
    const r = rig();
    for (let i = 0; i < 10_000; i++) r.record({ origin: `https://junk${i}.example`, surface: "book" });
    await r.settle();
    assert(
      r.writes.length <= FRAME_OBSERVE_MAX_KEYS,
      `10,000 forged origins cost at most ${FRAME_OBSERVE_MAX_KEYS} writes (got ${r.writes.length})`,
    );
    r.tick(FRAME_OBSERVE_FLUSH_MS);
    r.record({ origin: "https://www.trypennie.com", surface: "book" });
    await r.settle();
    const keys = new Set(r.writes.flat().map((w) => `${w.origin}|${w.surface}`));
    assert(keys.size <= FRAME_OBSERVE_MAX_KEYS + 2, `distinct keys stay bounded (${keys.size})`);
    eq(
      r.writes.flat().reduce((n, w) => n + w.loads, 0),
      10_001,
      "every load is still counted, the overflow under (other)",
    );
    assert(total(r.writes, "(other)") > 0, "the overflow is visible as (other)");
    assert(r.writes.flat().filter((w) => w.origin === "(other)").every((w) => !w.capped), "(other) is not itself capped");
  }

  // A failed write puts its counts back, so the next flush carries them.
  {
    const r = rig();
    r.failNext();
    r.record({ origin: "https://partner.example", surface: "manage" });
    await r.settle();
    eq(r.errors.length, 1, "the failure is reported");
    r.tick(FRAME_OBSERVE_FLUSH_MS);
    r.record({ origin: "https://partner.example", surface: "manage" });
    await r.settle();
    eq(total(r.writes, "https://partner.example"), 2, "the failed load is written with the next one");
  }

  // self and unstated name no site and never count against the cap.
  {
    const r = rig();
    r.record({ origin: "self", surface: "confirmation" });
    r.record({ origin: "unstated", surface: "book" });
    await r.settle();
    assert(r.writes.flat().every((w) => !w.capped), "self and unstated are uncapped");
  }

  finish();
}

void main();
