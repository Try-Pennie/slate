// DST-boundary test for slot computation: a 09:00-17:00 local working day must
// produce slots at the correct UTC instants on both sides of a US DST change,
// and on the transition day itself.
// Run: node --experimental-strip-types scripts/test-dst.ts
import {
  computeBucketSlots,
  type MemberAvailability,
} from "../src/lib/availability/compute.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const tz = "America/New_York";
const base = {
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  dailyCap: null as number | null,
  slotIntervalMin: 30,
  nowMs: Date.parse("2026-01-01T00:00:00.000Z"), // well before every window
};

// weekday: 1=Mon .. 7=Sun (Luxon). 540..1020 = 09:00-17:00 local.
function member(weekday: number): MemberAvailability {
  return {
    userId: "a",
    timezone: tz,
    rules: [{ weekday, start_minute: 540, end_minute: 1020 }],
    busy: [],
    bookingStartsMs: [],
  };
}

function firstSlotAndCount(weekday: number, from: string, to: string) {
  const slots = computeBucketSlots({ ...base, members: [member(weekday)], from, to });
  return { first: slots[0], count: slots.length };
}

// US spring-forward is Sun 2026-03-08 (02:00 EST -> 03:00 EDT).
// US fall-back is Sun 2026-11-01 (02:00 EDT -> 01:00 EST).

// Fri before spring-forward — EST (UTC-5): 09:00 = 14:00Z.
let r = firstSlotAndCount(5, "2026-03-06T00:00:00.000Z", "2026-03-07T00:00:00.000Z");
assert(r.first === "2026-03-06T14:00:00.000Z" && r.count === 16, "pre-spring Fri (EST): 09:00 = 14:00Z, 16 slots");

// Mon after spring-forward — EDT (UTC-4): 09:00 = 13:00Z.
r = firstSlotAndCount(1, "2026-03-09T00:00:00.000Z", "2026-03-10T00:00:00.000Z");
assert(r.first === "2026-03-09T13:00:00.000Z" && r.count === 16, "post-spring Mon (EDT): 09:00 = 13:00Z, 16 slots");

// Spring-forward day itself (Sun, now EDT after 02:00): 09:00 = 13:00Z.
r = firstSlotAndCount(7, "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z");
assert(r.first === "2026-03-08T13:00:00.000Z" && r.count === 16, "spring-forward day: 09:00 = 13:00Z (not shifted to 10:00)");

// Fall-back day itself (Sun, EST after 02:00): 09:00 = 14:00Z.
r = firstSlotAndCount(7, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
assert(r.first === "2026-11-01T14:00:00.000Z" && r.count === 16, "fall-back day: 09:00 = 14:00Z (not shifted to 08:00)");

// Mon after fall-back — EST (UTC-5): 09:00 = 14:00Z.
r = firstSlotAndCount(1, "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z");
assert(r.first === "2026-11-02T14:00:00.000Z" && r.count === 16, "post-fall-back Mon (EST): 09:00 = 14:00Z, 16 slots");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
