// Sanity test for the pure slot-computation core.
// Run: node --experimental-strip-types scripts/test-compute.ts
import {
  computeBucketSlots,
  freeMembersForSlot,
  type MemberAvailability,
} from "../src/lib/availability/compute.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("ok:", msg);
  }
}

const tz = "America/New_York";
// Monday 2026-06-08 .. Tuesday, NY time. Mon-Fri 09:00-17:00.
const from = "2026-06-08T04:00:00.000Z"; // 00:00 NY
const to = "2026-06-09T04:00:00.000Z";

const base = {
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  dailyCap: null as number | null,
  slotIntervalMin: 30,
  nowMs: Date.parse("2026-06-01T00:00:00.000Z"), // well before window
};

const memberA: MemberAvailability = {
  userId: "a",
  timezone: tz,
  rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
  busy: [],
  bookingStartsMs: [],
};

// 09:00..16:30 starts, step 30m => 16 slots.
const slotsA = computeBucketSlots({ ...base, members: [memberA], from, to });
assert(slotsA.length === 16, `single agent Mon 9-17 yields 16 slots (got ${slotsA.length})`);

// First slot is 09:00 NY = 13:00 UTC (EDT, -4).
assert(slotsA[0] === "2026-06-08T13:00:00.000Z", `first slot is 09:00 NY (got ${slotsA[0]})`);

// Busy 10:00-11:00 NY removes the 10:00 and 10:30 starts (2 slots).
const memberBusy: MemberAvailability = {
  ...memberA,
  busy: [
    {
      start: Date.parse("2026-06-08T14:00:00.000Z"),
      end: Date.parse("2026-06-08T15:00:00.000Z"),
    },
  ],
};
const slotsBusy = computeBucketSlots({ ...base, members: [memberBusy], from, to });
assert(slotsBusy.length === 14, `busy hour removes 2 slots (got ${slotsBusy.length})`);

// Union across two agents (one busy) still offers the slot if the other is free.
const slotsUnion = computeBucketSlots({
  ...base,
  members: [memberBusy, memberA],
  from,
  to,
});
assert(slotsUnion.length === 16, `union restores busy slots via second agent (got ${slotsUnion.length})`);

// Round-robin candidate detection at the busy instant: only agent A is free.
const busyInstant = Date.parse("2026-06-08T14:00:00.000Z");
const free = freeMembersForSlot([memberBusy, memberA], base, busyInstant);
assert(
  free.length === 1 && free[0] === "a",
  `only the free agent is a candidate at the busy instant (got ${JSON.stringify(free)})`,
);

// Min-notice excludes near-term slots.
const slotsNotice = computeBucketSlots({
  ...base,
  minNoticeMin: 60 * 24 * 365, // huge notice
  members: [memberA],
  from,
  to,
});
assert(slotsNotice.length === 0, `excessive min-notice yields no slots (got ${slotsNotice.length})`);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
