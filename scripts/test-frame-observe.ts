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
    at: (ms: number) => (now = ms),
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

  // The "first sighting today" set rolls on the business day, the one the database keys
  // rows by, never the UTC day. Checked across both boundaries, which differ by hours.
  {
    const r = rig();
    // Twenty seconds either side of 04:00 UTC on 2026-10-03, inside one flush window:
    // one UTC day, two Eastern days (EDT, UTC-4).
    r.at(Date.UTC(2026, 9, 3, 3, 59, 50));
    r.record({ origin: "https://partner.example", surface: "book" });
    await r.settle(); // one write in flight at a time: let the first land
    r.at(Date.UTC(2026, 9, 3, 4, 0, 10));
    r.record({ origin: "https://partner.example", surface: "book" });
    await r.settle();
    eq(r.writes.length, 2, "a new Eastern day is a new first sighting, though the UTC day is the same");

    const s = rig();
    // Twenty seconds either side of UTC midnight: two UTC days, one Eastern day.
    s.at(Date.UTC(2026, 9, 3, 23, 59, 50));
    s.record({ origin: "https://partner.example", surface: "book" });
    s.at(Date.UTC(2026, 9, 4, 0, 0, 10));
    s.record({ origin: "https://partner.example", surface: "book" });
    await s.settle();
    eq(s.writes.length, 1, "the same Eastern day is not a new first sighting, though the UTC day changed");
  }

  // A failed FIRST sighting is not marked seen: the next load of anything retries it at
  // once, rather than waiting a whole window, and the rare partner is not lost.
  {
    const r = rig();
    r.failNext();
    r.record({ origin: "https://rare.example", surface: "book" });
    await r.settle();
    eq(r.writes.length, 0, "the first sighting's write failed");
    r.tick(1_000);
    r.record({ origin: "https://www.trypennie.com", surface: "book" });
    await r.settle();
    eq(total(r.writes, "https://rare.example"), 1, "the next load, a second later, carries the rare host's first sighting");
  }

  // Only one write is in flight per isolate, so a failing database is not hit once per load.
  {
    const r = rig();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const writes: FramingBatchRow[][] = [];
    const recorder = makeFramingRecorder({
      write: async (rows) => {
        writes.push(rows);
        await gate;
      },
      now: () => 0,
      onError: () => {},
    });
    const deferred: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) recorder({ origin: `https://h${i}.example`, surface: "book" }, (p) => deferred.push(p));
    eq(writes.length, 1, "twenty new hosts while a write is in flight: still one write");
    release();
    await Promise.all(deferred);
    void r;
  }

  // The per isolate cap counts HOSTS, not (host, page) pairs: one host on six pages is one.
  {
    const r = rig();
    const pages = ["book", "advisor-link", "confirmation", "manage", "rebook", "other"];
    for (let i = 0; i < FRAME_OBSERVE_MAX_KEYS; i++) {
      for (const surface of pages) r.record({ origin: `https://h${i}.example`, surface });
      r.tick(FRAME_OBSERVE_FLUSH_MS);
    }
    await r.settle();
    eq(total(r.writes, "(other)"), 0, `${FRAME_OBSERVE_MAX_KEYS} hosts on every page are all named`);
    r.record({ origin: "https://one-too-many.example", surface: "book" });
    r.tick(FRAME_OBSERVE_FLUSH_MS);
    r.record({ origin: "https://h0.example", surface: "book" });
    await r.settle();
    eq(total(r.writes, "(other)"), 1, "the next new host is folded");
  }

  // A localhost port is allowed by the lock but not uncapped here, or a caller could mint
  // a fresh port per request and grow the table; an exact allow list host is uncapped.
  {
    const r = rig();
    r.record({ origin: "http://localhost:3000", surface: "book" });
    await r.settle(); // one write in flight at a time: let the first land
    r.record({ origin: "https://dev.trypennie.com", surface: "book" });
    await r.settle();
    const rows = r.writes.flat();
    eq(rows.find((w) => w.origin === "http://localhost:3000")?.capped, true, "a localhost port counts against the cap");
    eq(rows.find((w) => w.origin === "https://dev.trypennie.com")?.capped, false, "an exact listed host does not");
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
