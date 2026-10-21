// Test for coverage target selection (#972, #3308): the sweep that moves an absent
// advisor's calls answers "who can take this call" by the SAME rule as the booker and
// Reroute (`findRerouteTarget`): the round robin over the cached free advisors, then the
// live verify over the buffered window. Before #3308 it had a rule of its own (live Google
// and the daily cap only), so it could place a call on an advisor who was off shift.
// The out agent is never kept, and approved time off is checked on its own (#1236).
// Pure-with-fakes, so a node harness (no module mocking).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-target.ts
import { selectCoverageReassignTarget, type CoverageTargetDeps } from "../src/lib/booking/coverage-target.ts";
import {
  findRerouteTarget,
  VerifyUnavailableError,
  type RerouteTarget,
  type RerouteTargetDeps,
} from "../src/lib/booking/orchestration.ts";
import { freeMembersAtExactWindow, type MemberAvailability } from "../src/lib/availability/compute.ts";
import type { Booking, Bucket, EventType } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

// The production event type for buckets 1xx to 5xx (read 2026-10-21): 20 minutes, a
// 10 minute buffer either side, no daily cap.
const eventType = {
  id: "et1", duration_min: 20, buffer_before_min: 10, buffer_after_min: 10,
  min_notice_min: 120, daily_cap: null, slot_interval_min: 10,
} as unknown as EventType;
const bucket = { id: "b112", org_id: "org1", code: "112", is_test: false, event_type_id: "et1", fallback_user_id: null } as unknown as Bucket;
const OPEN = {
  zone: "UTC",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

// --- The shape of booking d04a619d (2026-10-05, bucket 112) -------------------------------
// 12:00 to 12:20 ET (16:00 to 16:20 UTC), held by OUT, swept at 14:45 UTC. Advisors are
// read from production with ids replaced (L155):
//  - BB had a call at 16:10 to 16:30 UTC, which its customer cancelled at 15:12:53;
//  - EC had calls at 16:00 to 16:20 (cancelled at 15:15:09) and at 16:30 to 16:50;
//  - OFF is a stand in for an advisor whose shift had ended: their calendar is empty, so
//    Google alone reads them as free.
// Reroute held a Low advisor for that time at 15:15:48, after both cancellations.
const START = "2026-10-05T16:00:00.000Z";
const END = "2026-10-05T16:20:00.000Z";
const SWEPT_AT = at("2026-10-05T14:45:29.000Z");
const booking = {
  id: "d04a619d", org_id: "org1", assigned_user_id: "OUT", starts_at: START, ends_at: END,
  bucket_id: "b112", event_type_id: "et1", kind: "routed", status: "confirmed",
} as unknown as Booking;

const shift = (startH: number, endH: number) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: startH * 60, end_minute: endH * 60 }));
const call = (startIso: string) => ({ start: at(startIso), end: at(startIso) + 20 * MIN });

function member(userId: string, busy: { start: number; end: number }[], rules = shift(13, 22)): MemberAvailability {
  return { userId, timezone: "UTC", rules, busy, bookingStartsMs: [], dayCounts: new Map() };
}

/**
 * The live search, wired to the REAL `findRerouteTarget`, with a round robin fake that runs
 * the booker's own exact window predicate over the members, and a Google fake that reads the
 * same calendars without any working hours, as freeBusy does.
 */
function liveSearch(members: MemberAvailability[], nowMs: number) {
  const verified: string[][] = [];
  const deps: RerouteTargetDeps = {
    resolveBucketByCode: async () => ({ bucket, eventType }),
    roundRobinCandidates: async (_b, et, startMs) => {
      const free = freeMembersAtExactWindow(
        members,
        {
          durationMin: et.duration_min, bufferBeforeMin: et.buffer_before_min, bufferAfterMin: et.buffer_after_min,
          minNoticeMin: 0, dailyCap: et.daily_cap, businessHours: OPEN, nowMs,
        },
        startMs,
      );
      return { candidates: free, memberCount: members.length, memberIds: members.map((m) => m.userId) };
    },
    loadEmails: async (ids) => new Map(ids.map((id) => [id, `${id}@x.com`])),
    verifyFree: async (emails, fromIso, toIso) => {
      verified.push(emails);
      const from = at(fromIso);
      const to = at(toIso);
      const free = emails.filter((e) => {
        const m = members.find((x) => `${x.userId}@x.com` === e);
        return !!m && !m.busy.some((b) => b.start < to && b.end > from);
      });
      return { free: new Set(free), unverified: new Set<string>() };
    },
    loadCurrentAgentPicture: async () => {
      throw new Error("the coverage search never asks about keeping the out agent");
    },
    now: () => nowMs,
  };
  const coverage: CoverageTargetDeps = {
    findTarget: (b, requested, excludeUserIds) => findRerouteTarget(deps, b, requested, { excludeUserIds }),
    userIdsOnApprovedTimeOff: async () => new Set(),
  };
  return { coverage, verified };
}

/** A recorded fake search, for the cases that are about the wrapper rather than the rule. */
function scripted(answers: (RerouteTarget | Error)[], away: (ids: string[]) => Promise<Set<string>> = async () => new Set()) {
  const calls: { booking: Booking; exclude: string[] }[] = [];
  const timeOff: { ids: string[]; startIso: string; endIso: string }[] = [];
  const deps: CoverageTargetDeps = {
    findTarget: async (b, _r, exclude) => {
      calls.push({ booking: b, exclude: [...exclude] });
      const next = answers.shift();
      if (!next) throw new Error("the test scripted no more answers");
      if (next instanceof Error) throw next;
      return next;
    },
    userIdsOnApprovedTimeOff: async (ids, startIso, endIso) => {
      timeOff.push({ ids, startIso, endIso });
      return away(ids);
    },
  };
  return { deps, calls, timeOff };
}
const move = (userId: string, outcome: "move-in-requested" | "move-cascaded" = "move-in-requested"): RerouteTarget => ({
  outcome, bucket, eventType, rungsDropped: outcome === "move-in-requested" ? 0 : 1, userId, email: `${userId}@x.com`, candidates: [userId],
});

async function run() {
  // --- #3308: the sweep judges a call by the booker's rule, not Google alone -------------
  {
    // At 14:45 UTC: BB and EC each have a call inside the buffered window [15:50, 16:30),
    // and OFF's shift ended at 15:00. Google alone reads OFF as free; the booker does not
    // offer an advisor off shift, and neither may the sweep.
    const off = member("OFF", [], shift(6, 15));
    const atSweep = [member("BB", [call("2026-10-05T16:10:00.000Z")]), member("EC", [call(START), call("2026-10-05T16:30:00.000Z")]), off];
    const { coverage, verified } = liveSearch(atSweep, SWEPT_AT);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, coverage);
    eq(r.assignment, null, "at sweep time nobody can take the call by the booker's rule, so it is unplaceable");
    eq(r.anyUnverified, false, "and that is a full slot, not an outage");
    assert(!verified.flat().includes("OFF@x.com"), "an advisor off shift is never offered, even with an empty calendar");
  }
  {
    // After the two cancellations: EC's 16:30 call starts exactly where the buffered window
    // ends, so it does not block, and BB is clear. The retry places the call, as Reroute did.
    const afterCancels = [member("BB", []), member("EC", [call("2026-10-05T16:30:00.000Z")])];
    const { coverage } = liveSearch(afterCancels, at("2026-10-05T15:15:48.000Z"));
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, coverage);
    eq(r.assignment?.userId, "BB", "once the cancellations free the time, the same search places the call");
  }
  {
    // The out agent is excluded and never kept, even when they still fit (a manager
    // covering an active agent's day): the live picture of the out agent is never read.
    const { coverage, verified } = liveSearch([member("OUT", []), member("EC", [])], SWEPT_AT);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, coverage);
    eq(r.assignment?.userId, "EC", "the out agent is passed over for the next free advisor");
    assert(!verified.flat().includes("OUT@x.com"), "and is never verified at all");
  }

  // --- The wrapper around the search -----------------------------------------------------
  {
    const s = scripted([move("B")]);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq(r.assignment?.userId, "B", "a move in the booking's own bucket is the target");
    eq(s.calls[0]?.booking.assigned_user_id, null, "the search is asked about the booking as if nobody held it");
    eq(s.calls[0]?.exclude, ["OUT"], "with the out agent excluded");
    eq(s.timeOff[0]?.ids, ["B"], "the pick alone is checked for approved time off");
    eq([s.timeOff[0]?.startIso, s.timeOff[0]?.endIso], [START, END], "over the booking's own window");
  }
  for (const outcome of ["keep-in-requested", "keep-cascaded", "keep-last-resort"] as const) {
    const s = scripted([{ outcome, bucket, eventType, rungsDropped: 0 }]);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, false], `${outcome} means nobody else anywhere: unplaceable, never a keep`);
  }
  {
    const s = scripted([move("C", "move-cascaded")]);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, false], "a target on a lower rung is nobody in this pool, never a move across buckets here");
  }

  // --- Failure paths: an answer that could not be known retries, never strands ----------
  {
    const s = scripted([new VerifyUnavailableError()]);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, true], "a live verify outage is unverified, so the item retries");
  }
  {
    const s = scripted([new Error("reroute holds read failed: connection reset")]);
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, true], "any other failed read behind the search retries too, rather than stopping the tick");
  }

  // --- #1236: a pick on approved time off is never a coverage target ---------------------
  {
    const s = scripted([move("B"), move("C")], async (ids) => new Set(ids.filter((id) => id === "B")));
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq(r.assignment?.userId, "C", "an advisor on approved time off is passed over even when the calendar shows them free");
    eq(s.calls[1]?.exclude, ["OUT", "B"], "by searching again without them");
  }
  {
    const s = scripted([move("B")], async () => {
      throw new Error("ooo read failed");
    });
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, true], "an unreadable time off check never places the call, and retries rather than settling unplaceable");
  }
  {
    const s = scripted([move("B"), move("C"), move("D"), move("E")], async (ids) => new Set(ids));
    const r = await selectCoverageReassignTarget({ booking, bucket, eventType }, s.deps);
    eq([r.assignment, r.anyUnverified], [null, true], "a run of picks all on time off stops and retries on a later tick");
    eq(s.calls.length, 4, "after a bounded number of searches");
  }
}

await run();
finish();
