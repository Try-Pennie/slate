// Sanity test for the pure slot-computation core.
// Run: node --experimental-strip-types scripts/test-compute.ts
import {
  computeBucketSlots,
  freeMembersForSlot,
  assembleMemberAvailability,
  isWithinWorkingHours,
  isBookableSlotForAgent,
  bookableSlotReason,
  capCountWindow,
  type MemberAvailability,
  type SlotRules,
  type WorkingRule,
} from "../src/lib/availability/compute.ts";
import { assert, finish } from "./lib/harness.ts";

const tz = "America/New_York";
/** Gate 1 (#1295) wide open, so it never interferes with what this file measures. */
const ALL_DAY_EVERY_DAY: WorkingRule[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  start_minute: 0,
  end_minute: 1440,
}));
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
  // Gate 1 (#1295) held open all week, so every assertion in this file stays about
  // the rule it was written for. The org gate has its own suite:
  // scripts/test-business-hours-gate.ts.
  businessHours: { zone: tz, rules: ALL_DAY_EVERY_DAY },
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

// --- assembleMemberAvailability (#249: map-based join, replaces O(N*M) filters) ---
{
  const userIds = ["a", "b"];
  const schedules = [{ id: "s1", user_id: "a", timezone: "America/Los_Angeles" }];
  const rules = [
    { schedule_id: "s1", weekday: 1, start_minute: 540, end_minute: 1020 },
    { schedule_id: "sX", weekday: 2, start_minute: 0, end_minute: 60 }, // other schedule -> ignored
  ];
  const busy = [
    { user_id: "a", starts_at: "2026-06-08T13:00:00.000Z", ends_at: "2026-06-08T13:30:00.000Z" },
    { user_id: "b", starts_at: "2026-06-08T14:00:00.000Z", ends_at: "2026-06-08T14:30:00.000Z" },
  ];
  // #832: the daily-cap count arrives per agent as a precomputed local-date -> count
  // map (from the server-side RPC), not a list of booking instants.
  const dayCountsByUser = new Map([["a", new Map([["2026-06-08", 1]])]]);
  const out = assembleMemberAvailability(userIds, schedules, rules, busy, dayCountsByUser);

  assert(out.length === 2 && out[0].userId === "a" && out[1].userId === "b", "preserves userIds order");
  const a = out[0];
  const b = out[1];
  assert(a.timezone === "America/Los_Angeles", "uses the agent's schedule timezone");
  assert(a.rules.length === 1 && a.rules[0].weekday === 1, "groups only the agent's own schedule's rules");
  assert(
    a.busy.length === 1 && a.busy[0].start === Date.parse("2026-06-08T13:00:00.000Z"),
    "busy parsed to epoch-ms for the right user",
  );
  assert(a.dayCounts?.get("2026-06-08") === 1, "adopts the per-agent dayCounts map");
  assert(b.timezone === "America/New_York" && b.rules.length === 0, "no schedule -> default tz + no rules");
  assert(b.busy.length === 1 && (b.dayCounts?.size ?? 0) === 0, "user b's busy grouped; empty day counts");
}

// --- isWithinWorkingHours (#527): rules-only on-shift guard for in-place reschedule ---
{
  // Monday 2026-06-08 NY, shift 09:00-17:00 (EDT, -4). 1=Mon..7=Sun (Luxon).
  const monFri9to5: WorkingRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  }));
  const ms = (iso: string) => Date.parse(iso);

  // 09:00-09:30 NY = 13:00-13:30 UTC — fully inside the shift.
  assert(
    isWithinWorkingHours(monFri9to5, tz, ms("2026-06-08T13:00:00.000Z"), ms("2026-06-08T13:30:00.000Z")),
    "within shift -> true",
  );
  // 16:30-17:00 NY = 20:30-21:00 UTC — ends exactly at shift end (inclusive).
  assert(
    isWithinWorkingHours(monFri9to5, tz, ms("2026-06-08T20:30:00.000Z"), ms("2026-06-08T21:00:00.000Z")),
    "interval ending exactly at shift end -> true",
  );
  // 17:00-17:30 NY = 21:00-21:30 UTC — starts at/after shift end (#527 scenario).
  assert(
    !isWithinWorkingHours(monFri9to5, tz, ms("2026-06-08T21:00:00.000Z"), ms("2026-06-08T21:30:00.000Z")),
    "interval starting past shift end -> false (the #527 gap)",
  );
  // 16:45-17:15 NY — straddles shift end by a few minutes.
  assert(
    !isWithinWorkingHours(monFri9to5, tz, ms("2026-06-08T20:45:00.000Z"), ms("2026-06-08T21:15:00.000Z")),
    "interval spilling a few minutes past shift end -> false",
  );
  // 08:30-09:00 NY = 12:30-13:00 UTC — starts before shift opens.
  assert(
    !isWithinWorkingHours(monFri9to5, tz, ms("2026-06-08T12:30:00.000Z"), ms("2026-06-08T13:00:00.000Z")),
    "interval starting before shift open -> false",
  );
  // Sunday 2026-06-07 (weekday 7) — no rule for that day.
  assert(
    !isWithinWorkingHours(monFri9to5, tz, ms("2026-06-07T13:00:00.000Z"), ms("2026-06-07T13:30:00.000Z")),
    "weekday with no shift rule -> false",
  );
  // No rules at all (schedule-less agent) -> off-shift everywhere.
  assert(
    !isWithinWorkingHours([], tz, ms("2026-06-08T13:00:00.000Z"), ms("2026-06-08T13:30:00.000Z")),
    "no working rules -> false (schedule-less agent re-routes)",
  );
}

// --- isBookableSlotForAgent (#536): one shared per-agent slot predicate reused by
//     memberOpenStarts AND the in-place reschedule guard, so the two can't drift. ---
{
  const ms = (iso: string) => Date.parse(iso);
  const monFri9to5: WorkingRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  }));
  const agent = {
    timezone: tz,
    rules: monFri9to5,
    busy: [] as { start: number; end: number }[],
    bookingStartsMs: [] as number[],
  };
  const rules: SlotRules = {
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    dailyCap: null,
    businessHours: { zone: tz, rules: ALL_DAY_EVERY_DAY },
  };
  const earlyNow = ms("2026-06-01T00:00:00.000Z"); // well before the window
  // Mon 2026-06-08 09:00 NY = 13:00 UTC.
  const slot = ms("2026-06-08T13:00:00.000Z");

  assert(
    isBookableSlotForAgent(agent, rules, slot, earlyNow),
    "bookable: on-shift, free, under cap, enough notice -> true",
  );

  // Off-shift: 17:00 NY (21:00 UTC) starts at shift end.
  assert(
    !isBookableSlotForAgent(agent, rules, ms("2026-06-08T21:00:00.000Z"), earlyNow),
    "not bookable: off-shift start past shift end -> false",
  );

  // Min-notice: now is 30 min before slot, notice is 60 min.
  assert(
    !isBookableSlotForAgent(agent, { ...rules, minNoticeMin: 60 }, slot, slot - 30 * 60_000),
    "not bookable: inside the min-notice window -> false",
  );

  // Daily cap: 2 confirmed bookings on the slot's local day, cap of 2.
  const capAgent = {
    ...agent,
    bookingStartsMs: [ms("2026-06-08T13:00:00.000Z"), ms("2026-06-08T15:00:00.000Z")],
  };
  assert(
    !isBookableSlotForAgent(capAgent, { ...rules, dailyCap: 2 }, slot, earlyNow),
    "not bookable: at the daily cap for the local day -> false",
  );
  assert(
    isBookableSlotForAgent(capAgent, { ...rules, dailyCap: 3 }, slot, earlyNow),
    "bookable: under the daily cap -> true",
  );
  assert(
    isBookableSlotForAgent(capAgent, { ...rules, dailyCap: null }, slot, earlyNow),
    "bookable: no daily cap configured -> true regardless of count",
  );

  // #(reassign-cap): the cap can be opted out (the in-place reschedule guard does this).
  const capAgent2 = {
    ...agent,
    bookingStartsMs: [ms("2026-06-08T13:00:00.000Z"), ms("2026-06-08T15:00:00.000Z")],
  };
  assert(
    !isBookableSlotForAgent(capAgent2, { ...rules, dailyCap: 2 }, slot, earlyNow),
    "cap enforced by default: at cap -> false",
  );
  assert(
    isBookableSlotForAgent(capAgent2, { ...rules, dailyCap: 2 }, slot, earlyNow, { enforceDailyCap: false }),
    "cap opt-out: over cap is bookable when enforceDailyCap=false (reschedule keep-same-agent)",
  );

  // Buffer: a busy block in the buffer-after window blocks the slot.
  const bufferAgent = {
    ...agent,
    busy: [{ start: ms("2026-06-08T13:30:00.000Z"), end: ms("2026-06-08T13:45:00.000Z") }],
  };
  assert(
    !isBookableSlotForAgent(bufferAgent, { ...rules, bufferAfterMin: 15 }, slot, earlyNow),
    "not bookable: busy block inside buffer-after window -> false",
  );
  assert(
    isBookableSlotForAgent(bufferAgent, { ...rules, bufferAfterMin: 0 }, slot, earlyNow),
    "bookable: adjacent busy block with no buffer -> true",
  );

  // ignoreBusy excludes the booking's OWN still-present event (#523) so a
  // sub-event-length in-place reschedule isn't a self-conflict.
  const ownEvent = { start: slot, end: slot + 30 * 60_000 };
  const selfAgent = { ...agent, busy: [ownEvent] };
  assert(
    !isBookableSlotForAgent(selfAgent, rules, slot, earlyNow),
    "not bookable: own event counted as a conflict without ignoreBusy",
  );
  assert(
    isBookableSlotForAgent(selfAgent, rules, slot, earlyNow, { ignoreBusy: ownEvent }),
    "bookable: own event excluded via ignoreBusy -> true (#523)",
  );

  // #739: duplicate/overlapping busy intervals over the SAME slot block it exactly
  // once (busy is an any-overlap predicate, never a sum), so two coincident busy
  // rows (a real, benign case: a daily hold coinciding with a weekly one) can't
  // over-subtract availability. The result must equal a single block, and a slot
  // the block doesn't cover stays bookable (no phantom bleed from the extra row).
  const dupBusy = { start: slot, end: slot + 30 * 60_000 };
  const oneBlock = { ...agent, busy: [dupBusy] };
  const twoIdentical = { ...agent, busy: [{ ...dupBusy }, { ...dupBusy }] };
  assert(
    isBookableSlotForAgent(oneBlock, rules, slot, earlyNow) ===
      isBookableSlotForAgent(twoIdentical, rules, slot, earlyNow) &&
      !isBookableSlotForAgent(twoIdentical, rules, slot, earlyNow),
    "#739: duplicate busy intervals block the covered slot exactly once (same as a single block)",
  );
  const uncoveredSlot = ms("2026-06-08T15:00:00.000Z"); // 11:00 NY, on-shift, not covered by dupBusy
  assert(
    isBookableSlotForAgent(twoIdentical, rules, uncoveredSlot, earlyNow),
    "#739: a slot outside the duplicated busy interval is unaffected (no over-subtraction)",
  );

  // --- bookableSlotReason (#543): the same predicate, but returns the SPECIFIC
  //     failing rule (or null when bookable) so a declined in-place reschedule
  //     leaves a breadcrumb. isBookableSlotForAgent is `reason === null`, so the
  //     two can never disagree. Order matches the predicate: min_notice, then
  //     working_hours, then daily_cap, then buffer. ---
  assert(
    bookableSlotReason(agent, rules, slot, earlyNow) === null,
    "reason: bookable slot -> null",
  );
  assert(
    bookableSlotReason(agent, { ...rules, minNoticeMin: 60 }, slot, slot - 30 * 60_000) ===
      "min_notice",
    "reason: inside min-notice window -> 'min_notice'",
  );
  assert(
    bookableSlotReason(agent, rules, ms("2026-06-08T21:00:00.000Z"), earlyNow) ===
      "working_hours",
    "reason: off-shift start -> 'working_hours'",
  );
  assert(
    bookableSlotReason(capAgent, { ...rules, dailyCap: 2 }, slot, earlyNow) === "daily_cap",
    "reason: at the daily cap -> 'daily_cap'",
  );
  assert(
    bookableSlotReason(capAgent, { ...rules, dailyCap: 2 }, slot, earlyNow, {
      enforceDailyCap: false,
    }) === null,
    "reason: over cap with enforceDailyCap=false -> null (in-place keep-same-agent)",
  );
  assert(
    bookableSlotReason(bufferAgent, { ...rules, bufferAfterMin: 15 }, slot, earlyNow) ===
      "buffer",
    "reason: busy block inside buffer-after window -> 'buffer'",
  );
  assert(
    bookableSlotReason(selfAgent, rules, slot, earlyNow, { ignoreBusy: ownEvent }) === null,
    "reason: own event excluded via ignoreBusy -> null (#523)",
  );
}

// --- capCountWindow (#540): widen a window so the daily-cap count covers the
//     agent's FULL local day regardless of timezone, even for a single-slot window
//     (the reroute/verify path loaded only the slot itself, so the cap never bit). ---
{
  const w = capCountWindow("2026-06-08T18:00:00.000Z", "2026-06-08T18:30:00.000Z");
  assert(
    w.from === "2026-06-07T18:00:00.000Z" && w.to === "2026-06-09T18:30:00.000Z",
    `capCountWindow widens by 24h each side (got ${w.from}..${w.to})`,
  );
  // The widened window must contain the full local day of the slot for any tz:
  // a slot at 18:00Z on 2026-06-08 has, in America/Los_Angeles, a local day
  // [2026-06-08T07:00:00Z, 2026-06-09T07:00:00Z) — both ends inside the window.
  assert(
    Date.parse(w.from) <= Date.parse("2026-06-08T07:00:00.000Z") &&
      Date.parse(w.to) >= Date.parse("2026-06-09T07:00:00.000Z"),
    "capCountWindow covers the slot's full local day (America/Los_Angeles)",
  );
}

finish();
