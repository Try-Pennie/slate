/**
 * Every word the Team capacity page shows (#3936), in one place, so the page and its tests read
 * the same strings and the design's checks (docs/design/team-capacity.checks.js) can hold the
 * page to the settled wording. Pure: luxon only.
 */
import { DateTime } from "luxon";
import type { TeamCapacityUnreadable } from "./team-capacity-load";

/** A day's label: Today and Tomorrow by name, then the weekday (D12 opens on Tomorrow). */
export function dayLabel(iso: string, todayIso: string, zone: string): { top: string; sub: string } {
  const d = DateTime.fromISO(iso, { zone });
  const today = DateTime.fromISO(todayIso, { zone });
  const wd = d.toFormat("ccc");
  const md = d.toFormat("LLL d");
  const diff = Math.round(d.diff(today, "days").days);
  if (diff === 0) return { top: "Today", sub: `${wd} ${md}` };
  if (diff === 1) return { top: "Tomorrow", sub: `${wd} ${md}` };
  return { top: wd, sub: md };
}

/** The label of a day picked outside the window: its weekday and date, never Today or Tomorrow. */
export function pickedDayLabel(iso: string, zone: string): { top: string; sub: string } {
  const d = DateTime.fromISO(iso, { zone });
  return { top: d.toFormat("ccc"), sub: d.toFormat("LLL d") };
}

export function callsOpenUnit(open: number): string {
  const word = OPEN_WORD.toLowerCase();
  return open === 1 ? ` call ${word}` : ` calls ${word}`;
}

export function nearlyFullSentence(pct: number): string {
  return `Nearly full at ${pct}% full or more.`;
}

export const BEYOND_WINDOW_NOTE = "Leads can't book this day yet, so it will fill up more than it shows.";

/** A day nobody could be counted on (everyone out, off shift or not syncing): never "0% full". */
export const NOBODY_COUNTED = "Nobody counted";

/** Today's card once every shift has ended (#4127): in place of the calls open number. */
export const DONE_FOR_TODAY = "Done for today";

/** Under Done for today: the calls the finished day left unused, from the saved history (#4127). */
export function unbookedLine(open: number): string {
  return `${open.toLocaleString("en-US")} ${open === 1 ? "call" : "calls"} went unbooked`;
}

/** A day everyone is out or has no shift (#4127): said once, with no time off line beside it. */
export const NO_ONE_ON_SHIFT = "No one on shift";

export function pastDaySummary(fullPct: number | null, open: number): string {
  if (fullPct === null) return "Nobody was counted this day.";
  return `Ended ${fullPct}% full, with room left for ${open.toLocaleString("en-US")} more ${open === 1 ? "call" : "calls"}.`;
}

/** A card's percent line: the share used, or that nobody could be counted. */
export function fullLine(fullPct: number | null): string {
  return fullPct === null ? NOBODY_COUNTED : `${fullPct}% full`;
}

/** A card's time off line: advisors on approved time off the whole day (#4101, decision 9). */
export function advisorsOffLine(n: number): string {
  return `${n} ${n === 1 ? "advisor" : "advisors"} off`;
}

/** A card's not syncing line: advisors left out because their calendar stopped syncing (#4101, decision 10). */
export function calendarsNotSyncingLine(n: number): string {
  return `${n} ${n === 1 ? "calendar" : "calendars"} not syncing`;
}

/**
 * A time of day in the office's zone, 9:30pm or 9pm, with its weekday after it when it is not
 * today (#4101, decision 3): Full by 9:30am Tue.
 */
export function clockWords(ms: number, zone: string, todayIso: string): string {
  const t = DateTime.fromMillis(ms, { zone });
  const time = t.toFormat(t.minute === 0 ? "ha" : "h:mma").toLowerCase();
  return t.toISODate() === todayIso ? time : `${time} ${t.toFormat("ccc")}`;
}

/** The pace line: calls taken an hour, whole, and never 0 for a day that is filling (#4101, decision 1). */
export function paceRateLine(perHour: number): string {
  return `Filling at ${Math.max(1, Math.round(perHour)).toLocaleString("en-US")} an hour`;
}

/**
 * The estimate line (#4101, decisions 2 and 4). Full means 95% of the card's capacity. The straight
 * line says it is this pace; the pattern, read from how days usually fill, carries no qualifier.
 */
export function estimateLine(method: "line" | "pattern", est: { atMs: number } | "wont-fill", zone: string, todayIso: string): string {
  const tail = method === "line" ? " at this pace" : "";
  return est === "wont-fill" ? `Won't fill${tail}` : `Full by ${clockWords(est.atMs, zone, todayIso)}${tail}`;
}

/**
 * A pace at or under 0, in place of both lines (#4101, decision 6), in the words a day gets when
 * its estimate lands after its last call (decision 21, #4190). Never a cause: the readings see a
 * call open up, not who freed it.
 */
export const NOT_FILLING = "Won't fill at this pace";
/** No pace yet: launch, or a new day joining the cards (#4101, decision 7). */
export const NO_PACE_YET = "Pace shows after 3 hours of readings";
/** After a gap in the readings, with the half hour the pace returns (#4101, decision 8). */
export function readingsMissedLine(backAtMs: number, zone: string, todayIso: string): string {
  return `Readings missed, pace back by ${clockWords(backAtMs, zone, todayIso)}`;
}

/** The one line under the cards when the readings could not be read (#4101, decision 12). */
export const PACE_UNREADABLE_COPY = { heading: "Couldn't load how fast the days are filling.", body: "Try reloading in a minute." };
/** The one line under the cards when the latest reading is out of date (#4101, decision 13). */
export function paceStaleSentence(sinceMs: number, zone: string, todayIso: string): string {
  return `Couldn't update how fast the days are filling since ${clockWords(sinceMs, zone, todayIso)}.`;
}

/**
 * One word for a call that still fits, Open, across the key, the timeline's column and the cards'
 * calls open (#4101, decision 15). The key names each of the timeline's marks (decision 14); Past
 * is on today's tab only.
 */
export const OPEN_WORD = "Open";
export const KEY_WORDS = { busy: "Busy", open: OPEN_WORD, off: "Not working", past: "Past" } as const;

export const OUT_WORDS = "Out, approved time off";
export function noShiftWords(isToday: boolean): string {
  return isToday ? "No shift today" : "No shift";
}
export const NOT_SYNCING_TAG = "Calendar not syncing";

const ZONE_SHORT: Record<string, string> = {
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Phoenix": "AZ",
  "America/Los_Angeles": "PT",
};
/** The short name beside an advisor, or the zone's own city for one not in the list. */
export function zoneShort(zone: string): string {
  return ZONE_SHORT[zone] ?? zone.split("/").pop()!.replace(/_/g, " ");
}

/**
 * The advisor's Google Calendar on the day shown, read only (D21). What Sam sees there, titles
 * or only busy, depends on how the calendar is shared in Google Workspace.
 */
export function calendarHref(email: string, iso: string, zone: string): string {
  const from = iso.replace(/-/g, "");
  const to = DateTime.fromISO(iso, { zone }).plus({ days: 1 }).toFormat("yyyyLLdd");
  const q = new URLSearchParams({ src: email, mode: "DAY", dates: `${from}/${to}`, ctz: zone });
  return `https://calendar.google.com/calendar/embed?${q.toString()}`;
}

/** The axis hours, 8am to 9pm in the office's zone (D16). */
export const AXIS_START_HOUR = 8;
export const AXIS_END_HOUR = 21;
export function axisLabel(hour: number): string {
  return `${hour > 12 ? hour - 12 : hour}${hour >= 12 ? "pm" : "am"}`;
}

/**
 * What the page says in place of everything else when it cannot measure (D26), one entry per
 * reason so `tsc` names a reason added without its words. A failed read says what failed and to
 * reload; a state the data is in says what the state is.
 */
export const UNMEASURABLE_COPY: Record<TeamCapacityUnreadable, { heading: string; body: string }> = {
  calendars: { heading: "Couldn't load advisor calendars", body: "Try reloading in a minute." },
  "business-hours": { heading: "Couldn't load the office hours", body: "Try reloading in a minute." },
  "booking-window": { heading: "Couldn't load the booking window", body: "Try reloading in a minute." },
  "event-type": { heading: "Couldn't work out the call length", body: "The buckets don't share one call setting, or it couldn't be read." },
  roster: { heading: "Couldn't load the advisor list", body: "Try reloading in a minute." },
  "time-off": { heading: "Couldn't load approved time off", body: "Try reloading in a minute." },
  "calendar-sync": { heading: "Couldn't check calendar sync", body: "Try reloading in a minute." },
  "no-open-days": { heading: "The office has no open day to show", body: "Every day in the booking window is closed." },
  "no-advisors": { heading: "Nobody is bookable", body: "No advisor is taking calls right now." },
};

/** The nearly full line a person typed, or why it was refused. */
export function parseNearlyFullPct(raw: string): { pct: number } | { error: string } {
  const t = raw.trim();
  if (!/^\d{1,2}$/.test(t)) return { error: "Enter a whole number from 1 to 99." };
  const n = Number(t);
  if (n < 1 || n > 99) return { error: "Enter a whole number from 1 to 99." };
  return { pct: n };
}

/** The nearly full line could not be read: never replaced by the default (0192's note). */
export const LINE_UNREADABLE_COPY = { heading: "Couldn't load the nearly full line", body: "Try reloading in a minute." };

/** Saved history could not be read, for the date picker or a past day (#3940). */
export const HISTORY_UNREADABLE_COPY = { heading: "Couldn't load past days", body: "Try reloading in a minute." };
