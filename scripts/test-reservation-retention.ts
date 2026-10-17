// #3847: the reservation retention sweep never deletes a reservation whose booking
// committed and whose booking.created is still owed.
//
// Since #3844 a booking that committed while its bucket stopped resolving keeps its
// reservation pending, and that reservation is the only record that Regal was never
// told about the booking. The sweep used to delete every pending reservation older
// than a day, so a missed `reservation_drain_stuck` page ended with the record gone
// and nothing left to show the send was owed. Now the sweep keeps it, and pages
// `reservation_created_owed` about it once a day until somebody resolves it, while
// a reservation whose booking never committed is still cleared after a day.
//
// Run: node --experimental-strip-types scripts/test-reservation-retention.ts
import {
  sweepExpiredReservations,
  settleOwedReservationAlert,
  type RetentionSeams,
  type RetentionSweep,
} from "../src/lib/booking/reservation-retention.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CUTOFF = "2026-10-15T12:00:00.000Z";

interface Row {
  id: string;
  idempotency_key: string;
}

function store(rows: Row[], committed: string[], fail: { list?: Error; committed?: Error; delete?: Error } = {}) {
  const deleted: string[][] = [];
  const askedKeys: string[][] = [];
  const seams: RetentionSeams = {
    listExpired: async (olderThanIso) => {
      eq(olderThanIso, CUTOFF, "the sweep asks for exactly the cutoff it was handed");
      if (fail.list) throw fail.list;
      return rows;
    },
    committedKeys: async (keys) => {
      askedKeys.push(keys);
      if (fail.committed) throw fail.committed;
      return new Set(keys.filter((k) => committed.includes(k)));
    },
    deleteIds: async (ids) => {
      if (fail.delete) throw fail.delete;
      deleted.push(ids);
      return ids.length;
    },
  };
  return { seams, deleted, askedKeys };
}

async function run() {
  // The headline: a committed reservation older than a day is KEPT and reported as
  // owed, while the stale one beside it (no booking ever committed) is deleted.
  {
    const { seams, deleted } = store(
      [
        { id: "owed1", idempotency_key: "k-owed1" },
        { id: "stale1", idempotency_key: "k-stale1" },
      ],
      ["k-owed1"],
    );
    const sweep = await sweepExpiredReservations(seams, CUTOFF, 15);
    eq(deleted, [["stale1"]], "only the reservation whose booking never committed is deleted");
    eq(sweep.owed, ["owed1"], "the committed one is kept and reported as owed");
    eq(sweep.deleted, 1, "the sweep reports how many it really deleted");
  }

  // CONTROL: ordinary stale reservations are still cleared, all of them in one pass
  // when they fit the limit.
  {
    const { seams, deleted } = store(
      [
        { id: "s1", idempotency_key: "k1" },
        { id: "s2", idempotency_key: "k2" },
      ],
      [],
    );
    const sweep = await sweepExpiredReservations(seams, CUTOFF, 15);
    eq(deleted, [["s1", "s2"]], "every expired reservation with no committed booking is deleted");
    eq(sweep.owed, [], "and nothing is reported owed");
  }

  // Kept rows must not starve the limit: with more owed rows than the limit at the
  // head of the table, the stale ones behind them are still deleted. A sweep that
  // read `limit` rows and then spared them would delete nothing for ever.
  {
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) rows.push({ id: `owed${i}`, idempotency_key: `ko${i}` });
    rows.push({ id: "stale-behind", idempotency_key: "ks" });
    const { seams, deleted } = store(rows, rows.slice(0, 20).map((r) => r.idempotency_key));
    const sweep = await sweepExpiredReservations(seams, CUTOFF, 15);
    eq(deleted, [["stale-behind"]], "a stale row behind more kept rows than the limit is still deleted");
    eq(sweep.owed.length, 20, "and every kept row is counted, not only a batch of them");
  }

  // The limit still bounds the delete.
  {
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) rows.push({ id: `s${i}`, idempotency_key: `k${i}` });
    const { seams, deleted } = store(rows, []);
    await sweepExpiredReservations(seams, CUTOFF, 15);
    eq(deleted.flat().length, 15, "no more than the limit is deleted in one pass");
  }

  // Nothing expired: no booking read and no delete.
  {
    const { seams, deleted, askedKeys } = store([], []);
    const sweep = await sweepExpiredReservations(seams, CUTOFF, 15);
    eq(deleted, [], "nothing expired issues no delete");
    eq(askedKeys, [], "and no booking read");
    eq(sweep, { deleted: 0, owed: [] }, "and reports a measured empty sweep");
  }

  // The failure path of the sweep's booking read: nothing may be deleted, because
  // a reservation it could not judge could be the only record of an owed send. It
  // throws, which is what reaches the lane's log and leaves the alert unmeasured.
  {
    const { seams, deleted } = store(
      [{ id: "owed1", idempotency_key: "k-owed1" }],
      ["k-owed1"],
      { committed: new Error("bookings read failed: 503") },
    );
    let threw: unknown = null;
    await sweepExpiredReservations(seams, CUTOFF, 15).catch((e) => (threw = e));
    assert(threw instanceof Error && /503/.test((threw as Error).message), "an unreadable booking check throws its own error");
    eq(deleted, [], "and deletes NOTHING it could not judge");
  }

  // The failure path of the candidate read.
  {
    const { seams, deleted } = store([], [], { list: new Error("reservations read failed") });
    let threw: unknown = null;
    await sweepExpiredReservations(seams, CUTOFF, 15).catch((e) => (threw = e));
    assert(threw instanceof Error, "an unreadable candidate list throws rather than reading as nothing expired");
    eq(deleted, [], "and deletes nothing");
  }

  // A refused delete throws too (#3126), rather than reading as a clean pass.
  {
    const { seams } = store([{ id: "s1", idempotency_key: "k1" }], [], { delete: new Error("deadlock detected") });
    let threw: unknown = null;
    await sweepExpiredReservations(seams, CUTOFF, 15).catch((e) => (threw = e));
    assert(threw instanceof Error && /deadlock/.test((threw as Error).message), "a refused delete throws");
  }

  // The page and its all-clear.
  const settle = async (sweep: RetentionSweep | null) => {
    const pages: { count: number; ids: string }[] = [];
    const resolved: string[] = [];
    const outcome = await settleOwedReservationAlert(sweep, {
      page: async (count, ids) => {
        pages.push({ count, ids });
      },
      resolve: async () => {
        resolved.push("reservation_created_owed");
      },
    });
    return { outcome, pages, resolved };
  };
  {
    const ids = Array.from({ length: 12 }, (_, i) => `owed${i}`);
    const { outcome, pages, resolved } = await settle({ deleted: 0, owed: ids });
    eq(outcome, "paged", "a kept owed reservation pages");
    eq(pages.length, 1, "once per sweep (the throttle decides how often it reaches Slack)");
    eq(pages[0].count, 12, "naming how many are owed");
    eq(pages[0].ids.split(", ").length, 10, "and the first ten ids");
    eq(resolved.length, 0, "and clears nothing");
  }
  {
    const { outcome, pages, resolved } = await settle({ deleted: 3, owed: [] });
    eq(outcome, "cleared", "a sweep that measured no owed reservation clears the condition");
    eq(pages.length, 0, "with no page");
    eq(resolved.length, 1, "and one all-clear");
  }
  {
    const { outcome, pages, resolved } = await settle(null);
    eq(outcome, "unmeasured", "a sweep that failed measured nothing");
    eq(pages.length, 0, "so it pages nothing");
    eq(resolved.length, 0, "and never announces recovery");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
