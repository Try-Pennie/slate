// #4390 (phase 4 of #4255): the times a program lead is shown, the real cached slots plus
// the placeholder's starts.
//
// What it pins, each beside a control:
//
//   - the placeholder's starts come from the coordinator page's ONE start predicate
//     (`offeredDays`), extended with the event type's minimum notice and slot interval:
//     notice, interval, zone and horizon each move them;
//   - SIDE BY SIDE with the real slots: an advisor free all day long, computed through the
//     real slot compute and every read time filter the real slots get, offers exactly the
//     placeholder's starts, and every filter a real slot passes leaves the placeholder's
//     starts unchanged;
//   - a day at the placeholder day limit, counted on the Eastern day of the CALL, shows
//     real slots only; a start offered by both is shown once, as the real slot;
//   - every failed read (the token secret, the settings, the hours, the horizon, the day
//     counts) shows real slots only AND is counted; a switch off, no token and a refused
//     token show real slots only and count nothing; a failed count never fails the times.
import { DateTime } from "luxon";
import {
  computeBucketSlots,
  filterSlotsFromNow,
  slotsWithinBusinessHours,
  type BusinessHoursRules,
} from "../src/lib/availability/compute.ts";
import { splitByLeadCallingWindow } from "../src/lib/booking/lead-calling-window.ts";
import { withinHorizon } from "../src/lib/booking/placed-booking.ts";
import { offeredDays } from "../src/lib/coordinator/bookable-hours.ts";
import {
  mergeProgramLeadTimes,
  placeholderCallDay,
  placeholderStarts,
  programLeadTimes,
  PROGRAM_TIMES_FALLBACKS,
  type ProgramLeadTimesDeps,
  type ProgramTimesFallback,
} from "../src/lib/booking/program-lead-times.ts";
import {
  PROGRAM_LEAD_HEADER,
  PROGRAM_LEAD_ZONE_PARAM,
  programLeadHeaders,
  programLeadTimesUrl,
} from "../src/lib/booking/program-lead-header.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 18 * 60 })),
  exceptions: [],
};
const MONDAY_MORNING = Date.parse("2026-06-08T12:00:00.000Z"); // 08:00 Eastern, Monday
const EVENT = { duration_min: 20, slot_interval_min: 30, min_notice_min: 0 };
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const CHICAGO = "America/Chicago";

const starts = (over: { zone?: string; nowMs?: number; horizonDays?: number; event?: Partial<typeof EVENT> } = {}) =>
  placeholderStarts({
    hours: HOURS,
    zone: over.zone ?? NY,
    nowMs: over.nowMs ?? MONDAY_MORNING,
    horizonDays: over.horizonDays ?? 2,
    eventType: { ...EVENT, ...over.event },
  });

// --- the shared start predicate --------------------------------------------------------
{
  const base = starts();
  eq(base.slice(0, 3), ["2026-06-08T13:00:00.000Z", "2026-06-08T13:30:00.000Z", "2026-06-08T14:00:00.000Z"],
    "control: a 30 minute interval offers starts on the half hour from the org's 09:00 Eastern, spelled as the real slots are (UTC)");
  eq(starts({ event: { slot_interval_min: 20 } }).slice(0, 3), ["2026-06-08T13:00:00.000Z", "2026-06-08T13:20:00.000Z", "2026-06-08T13:40:00.000Z"],
    "the interval moves the starts: the event type's slot interval, never a fixed quarter hour");
  eq(base[base.length - 1], "2026-06-09T21:30:00.000Z", "the last start is the last one whose 20 minute call ends inside Tuesday's hours");

  const nineOhFive = Date.parse("2026-06-08T13:05:00.000Z");
  eq(starts({ nowMs: nineOhFive })[0], "2026-06-08T13:30:00.000Z", "control: with no notice, the next half hour after now");
  eq(starts({ nowMs: nineOhFive, event: { min_notice_min: 60 } })[0], "2026-06-08T14:30:00.000Z",
    "the minimum notice moves the starts: the first is the first at or after now plus the notice");

  eq(starts({ zone: LA })[0], "2026-06-08T15:00:00.000Z",
    "the zone moves the starts: a Los Angeles lead's calling window opens at 08:00 Pacific, two hours after Pennie opens");
  eq(starts({ zone: "Not/AZone" })[0], starts({ zone: NY })[0],
    "an unreadable zone is judged in the calling window's own fallback zone, as the confirm judges it, never waved through");

  const days = (list: string[]) => [...new Set(list.map((iso) => DateTime.fromISO(iso, { zone: NY }).toISODate()))];
  eq(days(starts({ horizonDays: 1 })), ["2026-06-08"], "the horizon moves the starts: one open day offers Monday only");
  eq(days(starts({ horizonDays: 2 })), ["2026-06-08", "2026-06-09"], "control: two open days offer Monday and Tuesday");
  const fridayEvening = Date.parse("2026-06-12T23:00:00.000Z");
  eq(days(starts({ nowMs: fridayEvening, horizonDays: 1 })), ["2026-06-15"], "a closed weekend is skipped, as the horizon counts open days");

  // The coordinator page is unchanged: no notice and a quarter hour grid when not asked.
  const coordinator = offeredDays({ hours: HOURS, zone: NY, durationMin: 20, nowMs: MONDAY_MORNING, horizonDays: 1 });
  eq(coordinator[0]?.starts.slice(0, 2), ["2026-06-08T09:00:00.000-04:00", "2026-06-08T09:15:00.000-04:00"],
    "control: the coordinator page still offers quarter hours with no notice");
}

// --- side by side with the real slots ---------------------------------------------------
// An advisor in New York free all day, every day, with nothing booked: the real compute
// then offers every start the rules allow, so whatever filters a real slot shows up as a
// difference from the placeholder's starts.
for (const zone of [NY, CHICAGO, LA]) {
  for (const notice of [0, 45, 240]) {
    for (const interval of [15, 30]) {
      const nowMs = Date.parse("2026-06-08T13:05:00.000Z");
      const horizonDays = 2;
      const event = { duration_min: 20, slot_interval_min: interval, min_notice_min: notice };
      const real = computeBucketSlots({
        members: [{
          userId: "free-all-day",
          timezone: NY,
          rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
          busy: [],
          bookingStartsMs: [],
        }],
        durationMin: event.duration_min,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: notice,
        dailyCap: null,
        slotIntervalMin: interval,
        businessHours: HOURS,
        from: new Date(nowMs).toISOString(),
        to: new Date(nowMs + 7 * 86_400_000).toISOString(),
        nowMs,
      });
      // Every filter the real slots meet between the cache and the lead's screen.
      const served = splitByLeadCallingWindow(
        filterSlotsFromNow(slotsWithinBusinessHours(real, event.duration_min, HOURS), nowMs, notice),
        zone,
      ).offered.filter((iso) => withinHorizon(HOURS, Date.parse(iso), nowMs, horizonDays));
      const placeholder = placeholderStarts({ hours: HOURS, zone, nowMs, horizonDays, eventType: event });
      const label = `${zone}, ${notice} minutes notice, every ${interval} minutes`;
      assert(placeholder.length > 0, `control (${label}): the placeholder offers starts`);
      eq(placeholder, served, `side by side (${label}): an advisor free all day offers exactly the placeholder's starts`);
      eq(filterSlotsFromNow(placeholder, nowMs, notice), placeholder, `${label}: the notice filter removes no placeholder start`);
      eq(slotsWithinBusinessHours(placeholder, event.duration_min, HOURS), placeholder, `${label}: the business hours filter removes none`);
      eq(splitByLeadCallingWindow(placeholder, zone).outside, [], `${label}: the calling window filter removes none`);
      assert(placeholder.every((iso) => withinHorizon(HOURS, Date.parse(iso), nowMs, horizonDays)), `${label}: every placeholder start is inside the horizon`);
    }
  }
}

// --- the day limit and the merge ----------------------------------------------------------
{
  eq(placeholderCallDay(Date.parse("2026-06-09T03:30:00.000Z")), "2026-06-08",
    "a call at 23:30 Eastern counts on its Eastern day, not the UTC day it falls in");

  const placeholder = ["2026-06-08T13:00:00.000Z", "2026-06-08T13:30:00.000Z", "2026-06-09T13:00:00.000Z"];
  const real = ["2026-06-08T13:00:00.000-00:00", "2026-06-08T15:00:00.000Z"];
  const open = new Map([["2026-06-08", 0], ["2026-06-09", 0]]);
  const merged = mergeProgramLeadTimes({ realSlots: real, placeholder, heldByDay: open, dayLimit: 50 });
  eq(merged.slots, ["2026-06-08T13:00:00.000-00:00", "2026-06-08T13:30:00.000Z", "2026-06-08T15:00:00.000Z", "2026-06-09T13:00:00.000Z"],
    "control: real and placeholder starts together, in time order, a start both offer shown once in the real slot's own spelling");
  eq(merged.placeholderStarts, ["2026-06-08T13:30:00.000Z", "2026-06-09T13:00:00.000Z"],
    "only the starts no real advisor offers are marked as the placeholder's");

  const mondayFull = mergeProgramLeadTimes({ realSlots: real, placeholder, heldByDay: new Map([["2026-06-08", 50], ["2026-06-09", 49]]), dayLimit: 50 });
  eq(mondayFull.slots, ["2026-06-08T13:00:00.000-00:00", "2026-06-08T15:00:00.000Z", "2026-06-09T13:00:00.000Z"],
    "a day at the limit shows real slots only, while a day under it keeps its extra times");
  eq(mondayFull.placeholderStarts, ["2026-06-09T13:00:00.000Z"], "and marks only the day under the limit");
  eq(mergeProgramLeadTimes({ realSlots: real, placeholder, heldByDay: open, dayLimit: 0 }).slots, real,
    "a limit of 0 shows real slots only");
}

// --- what the client sends ------------------------------------------------------------------
{
  eq(programLeadHeaders(null), undefined, "control: an ordinary lead sends no header");
  eq(programLeadHeaders("tok"), { [PROGRAM_LEAD_HEADER]: "tok" }, "the token goes in a header, never the address Cloudflare logs");
  eq(programLeadTimesUrl("/api/availability?bucket=411", null, NY), "/api/availability?bucket=411",
    "control: an ordinary lead's address is unchanged, so its cached read is unchanged");
  eq(programLeadTimesUrl("/api/availability?bucket=411", "tok", NY), `/api/availability?bucket=411&${PROGRAM_LEAD_ZONE_PARAM}=America%2FNew_York`,
    "a program lead's address names the zone the calling window is judged in, so a change of zone is a new read");
  assert(!programLeadTimesUrl("/api/availability?bucket=411", "tok", NY).includes("tok"), "and never the token");
}

// --- the whole read, with every failure ------------------------------------------------------
const TOKEN = "00Q5f00000AbCdE.new.9999999999999.abc";
const REAL = ["2026-06-08T15:00:00.000Z"];

function world(over: Partial<ProgramLeadTimesDeps> = {}) {
  const counted: ProgramTimesFallback[] = [];
  const countReads: [string, string][] = [];
  const deps: ProgramLeadTimesDeps = {
    readToken: () => ({ ok: true }),
    readSettings: async () => ({ enabled: true, dayLimit: 50 }),
    loadHours: async () => HOURS,
    readHorizonDays: async () => 2,
    readDayCounts: async (from, to) => {
      countReads.push([from, to]);
      const out = new Map<string, number>();
      for (let d = DateTime.fromISO(from); d.toISODate()! <= to; d = d.plus({ days: 1 })) out.set(d.toISODate()!, 0);
      return out;
    },
    countFallback: async (reason) => {
      counted.push(reason);
    },
    now: () => MONDAY_MORNING,
    ...over,
  };
  return { deps, counted, countReads };
}
const ask = (over: { token?: string | null; leadZone?: string | null; fromMs?: number } = {}) => ({
  token: over.token === undefined ? TOKEN : over.token,
  leadZone: over.leadZone === undefined ? NY : over.leadZone,
  realSlots: REAL,
  eventType: EVENT,
  ...(over.fromMs === undefined ? {} : { fromMs: over.fromMs }),
});

await (async () => {
  {
    const w = world();
    const out = await programLeadTimes(ask(), w.deps);
    eq(out.outcome, "program", "control: a good token with the switch on is a program read");
    assert(out.slots.length > REAL.length && out.slots.includes(REAL[0]!), "and shows the real slots plus the placeholder's starts");
    eq(out.placeholderStarts.length, out.slots.length - 1, "every start but the real one is marked as the placeholder's");
    eq(w.countReads, [["2026-06-08", "2026-06-09"]], "the day counts are read ONCE, over the Eastern days the starts fall on");
    eq(w.counted, [], "and nothing is counted as a fallback");
  }
  {
    const w = world({ readDayCounts: async () => new Map([["2026-06-08", 50], ["2026-06-09", 0]]) });
    const out = await programLeadTimes(ask(), w.deps);
    assert(out.placeholderStarts.length > 0 && out.placeholderStarts.every((iso) => iso.startsWith("2026-06-09")),
      "a day at the limit loses its extra times, the next day keeps them");
  }
  {
    const w = world();
    const out = await programLeadTimes(ask({ fromMs: Date.parse("2026-06-09T04:00:00.000Z") }), w.deps);
    assert(out.placeholderStarts.every((iso) => iso >= "2026-06-09"), "starts before the asked day are left out, for the look further ahead");
    eq(w.countReads, [["2026-06-09", "2026-06-09"]], "and their days are not counted");
  }

  // Ordinary leads and ordinary refusals: real slots only, nothing read, nothing counted.
  for (const [label, token, readToken] of [
    ["no token", null, undefined],
    ["a forged token", TOKEN, () => ({ ok: false as const, reason: "forged" as const })],
    ["an expired token", TOKEN, () => ({ ok: false as const, reason: "expired" as const })],
  ] as const) {
    let settingsRead = false;
    const w = world({
      ...(readToken ? { readToken } : {}),
      readSettings: async () => {
        settingsRead = true;
        return { enabled: true, dayLimit: 50 };
      },
    });
    const out = await programLeadTimes(ask({ token }), w.deps);
    eq([out.slots, out.placeholderStarts], [REAL, []], `${label}: real slots only`);
    eq(w.counted, [], `${label}: nothing counted`);
    assert(!settingsRead, `${label}: nothing read`);
  }
  {
    const w = world({ readSettings: async () => ({ enabled: false, dayLimit: 50 }) });
    const out = await programLeadTimes(ask(), w.deps);
    eq([out.outcome, out.slots, w.counted], ["switch-off", REAL, []], "the switch off shows real slots only and is not a failure");
  }

  // Every failed read: real slots only, and counted once.
  const failures: [ProgramTimesFallback, Partial<ProgramLeadTimesDeps>][] = [
    ["token-secret-unset", { readToken: () => ({ ok: false, reason: "secret-unset" }) }],
    ["settings-unreadable", { readSettings: async () => null }],
    ["hours-unreadable", { loadHours: async () => { throw new Error("hours read failed"); } }],
    ["horizon-unreadable", { readHorizonDays: async () => null }],
    ["counts-unreadable", { readDayCounts: async () => { throw new Error("rpc failed"); } }],
    ["counts-unreadable", { readDayCounts: async () => new Map([["2026-06-08", 0]]) }],
    ["settings-unreadable", { readSettings: async () => { throw new Error("thrown, not null"); } }],
  ];
  for (const [reason, over] of failures) {
    const w = world(over);
    const out = await programLeadTimes(ask(), w.deps);
    eq([out.outcome, out.slots, out.placeholderStarts], [`fallback:${reason}`, REAL, []], `${reason}: real slots only`);
    eq(w.counted, [reason], `${reason}: counted once`);
  }
  for (const reason of PROGRAM_TIMES_FALLBACKS) {
    assert(failures.some(([r]) => r === reason), `the fallback ${reason} is produced by a case above`);
  }
  {
    const w = world({
      readSettings: async () => null,
      countFallback: async () => {
        throw new Error("the counter is down too");
      },
    });
    const out = await programLeadTimes(ask(), w.deps);
    eq([out.outcome, out.slots], ["fallback:settings-unreadable", REAL], "a counter that fails never fails the times");
  }
})();

finish();
