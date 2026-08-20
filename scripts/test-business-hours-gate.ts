// Gate 1 of three (#1295, milestone 24): the ORG's business hours, enforced inside
// the one shared per-slot predicate.
//
// Run: node --experimental-strip-types scripts/test-business-hours-gate.ts
//
// The load-bearing tests here are the NON-EASTERN agent ones. Every one of the 126
// live schedules is America/New_York with identical Mon-Fri 9-17 rules (measured in
// production 2026-08-06), so no test built from real data can tell a correct
// implementation apart from one that CLIPS the agent's window against the org's by
// comparing raw minute numbers. Clipping is wrong in both directions, and only a
// synthetic agent outside Eastern can show it:
//
//   * it REFUSES a morning that is genuinely inside the org's day (an agent west of
//     Eastern starting before 8am their own clock), and
//   * it ALLOWS an evening that is genuinely past the org's close (that same agent
//     working until 7pm their own clock, which is 10pm in the org's).
//
// So the org window and the agent window are judged independently, each in its own
// zone, and never intersected.
//
// Its companion is scripts/test-availability-zones.ts (#1316), which takes the same
// non-Eastern angle further: the org's day spanning two of the agent's local
// WEEKDAYS, the spring-forward hour that does not exist, the booker's own zone being
// display only, and an agent whose whole working day is the org's night. Check both
// before adding a case to either, or the reasoning gets written a third time.
import {
  computeBucketSlots,
  bookableSlotReason,
  isBookableSlotForAgent,
  type MemberAvailability,
  type SlotRules,
  type WorkingRule,
} from "../src/lib/availability/compute.ts";
import {
  SEEDED_BUSINESS_HOURS,
  BUSINESS_ZONE,
  type BusinessWindow,
} from "../src/lib/booking/business-hours.ts";
import { assert, finish } from "./lib/harness.ts";

const ms = (iso: string) => Date.parse(iso);
const EARLY_NOW = ms("2026-01-01T00:00:00.000Z"); // well before every window below

/** The seeded org week: Mon-Sat 08:00-20:00 America/New_York, Sunday closed. */
const openWeek = { zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions: [] };

const slotRules = (businessHours: { zone: string; rules: BusinessWindow[], exceptions: [] }): SlotRules => ({
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  dailyCap: null,
  businessHours,
});

const agentOn = (
  timezone: string,
  rules: WorkingRule[],
): Pick<MemberAvailability, "timezone" | "rules" | "busy" | "bookingStartsMs"> => ({
  timezone,
  rules,
  busy: [],
  bookingStartsMs: [],
});

// --- The non-Eastern agent, west of the org (the case clipping gets wrong) ---------
{
  // Monday 2026-06-08. Los Angeles is PDT (-7), New York is EDT (-4).
  // The agent's own shift is 06:00-09:00 Pacific, which is 09:00-12:00 Eastern:
  // squarely inside the org's 8-to-8 day, even though it starts before 8am on the
  // agent's own clock.
  const early = agentOn("America/Los_Angeles", [
    { weekday: 1, start_minute: 6 * 60, end_minute: 9 * 60 },
  ]);
  const sixThirtyPacific = ms("2026-06-08T13:30:00.000Z"); // 06:30 PDT = 09:30 EDT

  assert(
    bookableSlotReason(early, slotRules(openWeek), sixThirtyPacific, EARLY_NOW) === null,
    "west of the org: 06:30 Pacific is 09:30 Eastern, inside the org day -> bookable",
  );

  // The same agent working late: 17:00-19:00 Pacific is 20:00-22:00 Eastern, entirely
  // at or past the org's 20:00 close. Clipping minute numbers would wave this through.
  const late = agentOn("America/Los_Angeles", [
    { weekday: 1, start_minute: 17 * 60, end_minute: 19 * 60 },
  ]);
  const fivePacific = ms("2026-06-09T00:00:00.000Z"); // 17:00 PDT Mon = 20:00 EDT Mon
  const sixPacific = ms("2026-06-09T01:00:00.000Z"); // 18:00 PDT Mon = 21:00 EDT Mon

  assert(
    bookableSlotReason(late, slotRules(openWeek), fivePacific, EARLY_NOW) === "business_hours",
    "west of the org: 17:00 Pacific ends past the org's 20:00 Eastern close -> business_hours",
  );
  assert(
    bookableSlotReason(late, slotRules(openWeek), sixPacific, EARLY_NOW) === "business_hours",
    "west of the org: 18:00 Pacific is 21:00 Eastern, wholly outside -> business_hours",
  );
}

// --- A zone whose DST transition is on a DIFFERENT date than the org's -------------
{
  // The US springs forward on 2026-03-08; the UK does not until 2026-03-29. So on
  // Monday 2026-03-09 London is UTC+0 while New York is UTC-4: a FOUR hour gap where
  // the usual one is five. An implementation holding a fixed offset (or doing the
  // conversion on the wrong date) gets both of these backwards.
  const london = agentOn("Europe/London", [
    { weekday: 1, start_minute: 11 * 60, end_minute: 14 * 60 },
  ]);
  const noonLondon = ms("2026-03-09T12:00:00.000Z"); // 12:00 GMT = 08:00 EDT
  const elevenLondon = ms("2026-03-09T11:00:00.000Z"); // 11:00 GMT = 07:00 EDT

  assert(
    bookableSlotReason(london, slotRules(openWeek), noonLondon, EARLY_NOW) === null,
    "off-cycle DST: 12:00 London is 08:00 Eastern, exactly the org's open -> bookable",
  );
  assert(
    bookableSlotReason(london, slotRules(openWeek), elevenLondon, EARLY_NOW) === "business_hours",
    "off-cycle DST: 11:00 London is 07:00 Eastern, before the org opens -> business_hours",
  );
}

// --- A day the org is closed beats an agent who is on shift ------------------------
{
  // Sunday 2026-06-14. The agent has Sunday hours; the org does not.
  const sundayAgent = agentOn(BUSINESS_ZONE, [
    { weekday: 7, start_minute: 10 * 60, end_minute: 14 * 60 },
  ]);
  const sundayTen = ms("2026-06-14T14:00:00.000Z"); // 10:00 EDT Sunday

  assert(
    isBookableSlotForAgent(sundayAgent, slotRules(openWeek), sundayTen, EARLY_NOW) === false,
    "the org is closed Sunday, so an agent who works Sunday is still not bookable",
  );
  assert(
    bookableSlotReason(sundayAgent, slotRules(openWeek), sundayTen, EARLY_NOW) === "business_hours",
    "a closed day reports business_hours, not the agent's own working_hours",
  );
}

// --- The slot must fit ENTIRELY inside the org window, like the agent's ------------
{
  const lateAgent = agentOn(BUSINESS_ZONE, [
    { weekday: 1, start_minute: 9 * 60, end_minute: 21 * 60 },
  ]);
  const sevenFortyFive = ms("2026-06-08T23:45:00.000Z"); // 19:45 EDT, ends 20:15
  const sevenThirty = ms("2026-06-08T23:30:00.000Z"); // 19:30 EDT, ends 20:00 exactly

  assert(
    bookableSlotReason(lateAgent, slotRules(openWeek), sevenFortyFive, EARLY_NOW) ===
      "business_hours",
    "a slot straddling the 20:00 close is refused, not truncated",
  );
  assert(
    bookableSlotReason(lateAgent, slotRules(openWeek), sevenThirty, EARLY_NOW) === null,
    "a slot ending exactly at the 20:00 close is bookable",
  );
}

// --- Precedence: where business_hours sits among the other reasons -----------------
{
  const agent = agentOn(BUSINESS_ZONE, [
    { weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
  ]);
  // Monday 07:00 EDT: outside the org's day AND outside the agent's shift.
  const sevenAm = ms("2026-06-08T11:00:00.000Z");

  assert(
    bookableSlotReason(agent, slotRules(openWeek), sevenAm, EARLY_NOW) === "business_hours",
    "outside BOTH windows reports the org's closure first, not the agent's shift",
  );
  // Minimum notice is cheaper and stays ahead of it: a closed-day slot that is also
  // too soon reports min_notice, so the existing reason order is unchanged.
  const sundayTen = ms("2026-06-14T14:00:00.000Z");
  assert(
    bookableSlotReason(
      agentOn(BUSINESS_ZONE, [{ weekday: 7, start_minute: 10 * 60, end_minute: 14 * 60 }]),
      { ...slotRules(openWeek), minNoticeMin: 120 },
      sundayTen,
      sundayTen - 30 * 60_000,
    ) === "min_notice",
    "minimum notice still outranks the org's hours",
  );
}

// --- An all-closed week refuses everything, and that is a legitimate answer --------
{
  // `resolveBusinessHours` returns NO windows for a week whose every day is stored
  // closed. That is a decision someone made, so the gate honours it. It is also why
  // the loader THROWS on an unreadable week rather than returning an empty list: an
  // empty list here means "shut", and a read error must never be able to say that.
  const agent = agentOn(BUSINESS_ZONE, [
    { weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
  ]);
  const monNine = ms("2026-06-08T13:00:00.000Z");

  assert(
    bookableSlotReason(agent, slotRules({ zone: BUSINESS_ZONE, rules: [], exceptions: [] }), monNine, EARLY_NOW) ===
      "business_hours",
    "an org closed every day offers nothing, however wide the agent's own hours are",
  );
}

// --- End to end through computeBucketSlots -----------------------------------------
{
  const from = "2026-06-08T04:00:00.000Z"; // 00:00 Monday, NY
  const to = "2026-06-09T04:00:00.000Z";
  const member: MemberAvailability = {
    userId: "a",
    timezone: BUSINESS_ZONE,
    rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
    busy: [],
    bookingStartsMs: [],
  };
  const base = {
    members: [member],
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    dailyCap: null as number | null,
    slotIntervalMin: 30,
    from,
    to,
    nowMs: EARLY_NOW,
  };

  // The seeded week is a strict superset of every live agent window (measured), so
  // switching the gate on changes nothing today. That is the whole safety argument
  // for landing enforcement before the editor and the backfill.
  const wide = computeBucketSlots({ ...base, businessHours: openWeek });
  assert(wide.length === 16, `the seeded 8-to-8 week leaves Mon 9-17 untouched (got ${wide.length})`);

  // Narrow the org to 10:00-15:00 and the same agent loses the edges: 10:00..14:30.
  const narrowed = computeBucketSlots({
    ...base,
    businessHours: {
      zone: BUSINESS_ZONE,
      rules: [{ weekday: 1, start_minute: 10 * 60, end_minute: 15 * 60 }], exceptions: [] },
  });
  assert(
    narrowed.length === 10 && narrowed[0] === "2026-06-08T14:00:00.000Z",
    `narrowing the org to 10-15 trims the agent's day to 10 slots from 10:00 (got ${narrowed.length}, first ${narrowed[0]})`,
  );
}

// --- the per-pass memo must never be able to change an answer ---------------------
{
  // `computeBucketSlots` asks the org the same question once per instant and reuses
  // it across all members, because the org's answer cannot depend on whose diary is
  // being read. That is a real assumption, so it is checked rather than asserted: the
  // memoized run must equal a run that consults the predicate for every single slot.
  const narrow = {
    zone: BUSINESS_ZONE,
    rules: [{ weekday: 1, start_minute: 10 * 60, end_minute: 15 * 60 }], exceptions: [] };
  const mkMember = (userId: string, startHour: number): MemberAvailability => ({
    userId,
    timezone: BUSINESS_ZONE,
    rules: [{ weekday: 1, start_minute: startHour * 60, end_minute: 18 * 60 }],
    busy: [],
    bookingStartsMs: [],
  });
  const members = [mkMember("a", 8), mkMember("b", 9), mkMember("c", 13)];
  const input = {
    members,
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    dailyCap: null as number | null,
    slotIntervalMin: 30,
    businessHours: narrow,
    from: "2026-06-08T04:00:00.000Z",
    to: "2026-06-09T04:00:00.000Z",
    nowMs: EARLY_NOW,
  };

  const memoized = computeBucketSlots(input);
  // The same union, but every slot judged through a fresh predicate call, no memo.
  const bySlot = new Set<string>();
  for (let t = ms("2026-06-08T04:00:00.000Z"); t < ms("2026-06-09T04:00:00.000Z"); t += 30 * 60_000) {
    for (const m of members) {
      if (bookableSlotReason(m, slotRules(narrow), t, EARLY_NOW) === null) {
        bySlot.add(new Date(t).toISOString());
      }
    }
  }
  assert(
    memoized.length > 0 && memoized.join(",") === [...bySlot].sort().join(","),
    `the memoized pass matches a per-slot unmemoized pass exactly (${memoized.length} vs ${bySlot.size})`,
  );

  // And the memo lives only for its own call: a second run under DIFFERENT hours
  // must not reuse the first run's verdicts.
  const reopened = computeBucketSlots({
    ...input,
    businessHours: { zone: BUSINESS_ZONE, rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 18 * 60 }], exceptions: [] },
  });
  assert(
    reopened.length > memoized.length,
    `a widened week takes effect on the next call, so the memo is not shared between passes (${memoized.length} -> ${reopened.length})`,
  );
}

finish();
