// #3359: the stuck-drain all-clear is decided from STORED rows, never from what one
// tick happened to retry.
//
// On 2026-10-06 one crash recovered reservation sat pending at 5 and more attempts
// on the hourly backoff. A backing-off row is not loaded on most ticks, so most
// ticks found nothing stuck in THEIR batch and sent "the reservations have
// completed", and the next retry paged again: page and all-clear pairs at 2:49,
// 3:01, 3:38 and 9:41 AM ET about a row that never moved. That is an all-clear off
// a tick that measured nothing (#1152, L98). The outbox drain beside it made the
// same decision the same way, so both lanes go through this one judge (L30).
//
// Run: node --experimental-strip-types scripts/test-drain-stuck-alert.ts
import { settleDrainStuckAlert, type DrainStuckSeams } from "../src/lib/booking/drain-stuck-alert.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const RECOVERY = { key: "reservation_drain_stuck", text: "recovered" };

function harness(stored: number | Error) {
  const resolved: { key: string; text: string }[] = [];
  const pages: { count: number; ids: string }[] = [];
  let counted = 0;
  const seams: DrainStuckSeams = {
    countStoredStuck: async () => {
      counted += 1;
      if (stored instanceof Error) throw stored;
      return stored;
    },
    page: async (count, ids) => {
      pages.push({ count, ids });
    },
    resolve: async (entries) => {
      resolved.push(...entries);
    },
  };
  return { seams, resolved, pages, counted: () => counted };
}

async function run() {
  // The production shape: this tick retried nothing past the threshold (the row
  // was backing off), and the store still holds it at 5+ attempts.
  {
    const { seams, resolved, pages } = harness(1);
    const outcome = await settleDrainStuckAlert([], RECOVERY, seams);
    eq(outcome, "still-stuck", "a stored row at the threshold is still stuck, whatever this tick retried");
    eq(resolved.length, 0, "and NO all-clear is sent while it sits there backing off");
    eq(pages.length, 0, "nor a second page from a tick that retried nothing");
  }

  // The failure path: the stored state could not be read. Nothing was measured,
  // so nothing may be cleared (#1152).
  {
    const { seams, resolved } = harness(new Error("supabase 503"));
    const outcome = await settleDrainStuckAlert([], RECOVERY, seams);
    eq(outcome, "unmeasured", "an unreadable store is reported as unmeasured");
    eq(resolved.length, 0, "an unreadable store never announces recovery");
  }

  // Healthy: the store holds nothing at the threshold, so the condition is over.
  {
    const { seams, resolved, pages } = harness(0);
    const outcome = await settleDrainStuckAlert([], RECOVERY, seams);
    eq(outcome, "cleared", "nothing stored at the threshold clears the condition");
    eq(resolved, [RECOVERY], "with the condition's own all-clear");
    eq(pages.length, 0, "and no page");
  }

  // A tick that bumped rows past the threshold pages them, as before, and clears
  // nothing; the store is not read, since it can only agree.
  {
    const { seams, resolved, pages, counted } = harness(0);
    const outcome = await settleDrainStuckAlert(
      [{ id: "r1" }, { id: "r2" }],
      RECOVERY,
      seams,
    );
    eq(outcome, "paged", "a tick that found stuck rows pages");
    eq(pages, [{ count: 2, ids: "r1, r2" }], "naming how many and which");
    eq(resolved.length, 0, "and sends no all-clear in the same breath");
    eq(counted(), 0, "without spending a read on the store");
  }

  // The page names at most ten rows, as the alert always has.
  {
    const { seams, pages } = harness(0);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}` }));
    await settleDrainStuckAlert(many, RECOVERY, seams);
    eq(pages[0]?.count, 12, "the count is every stuck row");
    eq(pages[0]?.ids.split(", ").length, 10, "the id list stops at ten");
  }

  // Extra keys a caller has measured healthy this tick ride in the same batch, so
  // the outbox lane still settles its hand-off streak with one alert_state read.
  // They are cleared even when the stuck condition is not, because they were
  // measured on their own, and never when the caller did not pass them.
  {
    const handoff = { key: "outbox_handoff", text: "handoff over" };
    const stuck = harness(3);
    await settleDrainStuckAlert([], RECOVERY, stuck.seams, [handoff]);
    eq(stuck.resolved, [handoff], "a still-stuck tick clears only what the caller measured itself");
    const healthy = harness(0);
    await settleDrainStuckAlert([], RECOVERY, healthy.seams, [handoff]);
    eq(healthy.resolved, [RECOVERY, handoff], "a healthy tick clears both in one batch");
    const unread = harness(new Error("down"));
    await settleDrainStuckAlert([], RECOVERY, unread.seams, [handoff]);
    eq(unread.resolved, [handoff], "an unreadable store still never clears the stuck condition");
  }

  assert(true, "done");
}

await run();
finish();
