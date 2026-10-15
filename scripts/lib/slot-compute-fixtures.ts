// Generated inputs for `computeBucketSlots` (#2806), shared by the equivalence
// suite (scripts/test-slot-walk-equivalence.ts) and the CPU benchmark
// (scripts/bench-bucket-slots.ts), so the fixture the speed was measured on and the
// fixtures the answer was proved on are built by the same code.
//
// Every field is one `SlotComputeInput` really carries; nothing is read from
// production. The shape is deliberately production LIKE rather than uniform:
//
//   * a pool of 74 to 80 agents spread over the seven zones the roster spans
//     (docs/architecture.md, #1739), weighted toward Eastern with a Phoenix and
//     a Los Angeles contingent, because a fixture with every agent in the org's
//     zone cannot tell a zone fault from a correct walk;
//   * working hours with split shifts, Saturdays, a 24:00 close and the odd rule a
//     form would never write (a :05 start, an empty window);
//   * busy time at roughly a working day's density, with overlaps, all day blocks
//     and blocks that straddle a shift edge, so the buffer check meets every case;
//   * daily cap counts keyed by the agent's LOCAL date, at, under and over the cap.
//
// Seeded, so a failing case is reproducible from the seed the suite prints.
import { DateTime } from "luxon";
import type {
  BusinessHoursRules,
  MemberAvailability,
  SlotComputeInput,
  WorkingRule,
} from "../../src/lib/availability/compute.ts";

/** Small, fast, seedable PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** The seven roster zones, weighted roughly as the roster is (#1739). */
export const ROSTER_ZONES: readonly string[] = [
  ...Array(8).fill("America/New_York"),
  ...Array(2).fill("America/Chicago"),
  "America/Denver",
  ...Array(4).fill("America/Phoenix"),
  ...Array(3).fill("America/Los_Angeles"),
  "America/Anchorage",
  "Pacific/Honolulu",
];

/**
 * Zones whose clocks do something unusual, for the equivalence suite only: a DST
 * change AT midnight (Santiago, Havana, Asuncion, Cairo, Beirut), a half hour DST
 * shift (Lord Howe), quarter hour offsets (Kathmandu, Chatham), the far side of the
 * date line (Kiritimati, Pago Pago), and the southern hemisphere's opposite season.
 */
export const AWKWARD_ZONES: readonly string[] = [
  "America/Santiago",
  "America/Havana",
  "America/Asuncion",
  "Africa/Cairo",
  "Asia/Beirut",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "Pacific/Chatham",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Europe/London",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** The seeded org week (migration 0098): Mon to Sat 08:00 to 20:00 Eastern, Sunday shut. */
export function seededBusinessHours(): BusinessHoursRules {
  const rules: WorkingRule[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start_minute: 480,
    end_minute: 1200,
  }));
  return { zone: "America/New_York", rules, exceptions: [] };
}

function workingRules(r: () => number, odd: boolean, everyDayShare: number): WorkingRule[] {
  const rules: WorkingRule[] = [];
  const days =
    r() < everyDayShare
      ? [1, 2, 3, 4, 5, 6, 7]
      : r() < 0.15
        ? [1, 2, 3, 4, 5, 6]
        : r() < 0.1
          ? [2, 3, 4, 5, 6, 7]
          : [1, 2, 3, 4, 5];
  const start = pick(r, [420, 480, 510, 540, 570, 600, 660]);
  const len = pick(r, [480, 510, 540, 600]);
  const split = r() < 0.2;
  for (const weekday of days) {
    if (split) {
      rules.push({ weekday, start_minute: start, end_minute: start + 240 });
      rules.push({ weekday, start_minute: start + 300, end_minute: Math.min(1440, start + len + 60) });
    } else {
      rules.push({ weekday, start_minute: start, end_minute: Math.min(1440, start + len) });
    }
  }
  if (odd) {
    // What a form would never write and the table can still hold: an off grid
    // start, a 24:00 close, a window shorter than one call, an inverted one, and
    // an early morning window that sits in a DST gap on a change day.
    const weekday = int(r, 1, 7);
    switch (int(r, 0, 4)) {
      case 0: rules.push({ weekday, start_minute: int(r, 0, 1400), end_minute: 1440 }); break;
      case 1: rules.push({ weekday, start_minute: 545, end_minute: 1025 }); break;
      case 2: rules.push({ weekday, start_minute: 600, end_minute: 610 }); break;
      case 3: rules.push({ weekday, start_minute: 900, end_minute: 840 }); break;
      default: rules.push({ weekday, start_minute: 0, end_minute: 240 }); break;
    }
  }
  return rules;
}

/** The member's local days covering the window, with one spare day either side. */
function localDaysAround(zone: string, fromMs: number, toMs: number): DateTime[] {
  const days: DateTime[] = [];
  let day = DateTime.fromMillis(fromMs, { zone }).startOf("day").minus({ days: 1 });
  const last = DateTime.fromMillis(toMs, { zone }).startOf("day").plus({ days: 1 });
  while (day <= last) {
    days.push(day);
    day = day.plus({ days: 1 });
  }
  return days;
}

function busyBlocks(
  r: () => number,
  zone: string,
  fromMs: number,
  toMs: number,
  perDay: number,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const day of localDaysAround(zone, fromMs, toMs)) {
    const n = Math.max(0, Math.round(perDay + (r() - 0.5) * perDay));
    for (let i = 0; i < n; i++) {
      // A five minute grid, plus the odd off grid minute, as calendar events are.
      const minute = r() < 0.85 ? int(r, 84, 252) * 5 : int(r, 0, 1439);
      const dur = pick(r, [15, 20, 20, 30, 30, 30, 45, 60, 60, 90, 120]);
      const start = day.plus({ minutes: minute }).toMillis();
      out.push({ start, end: start + dur * 60_000 });
    }
    if (r() < 0.03) {
      // An all day block (an approved time off), sometimes a few days long.
      const start = day.toMillis();
      out.push({ start, end: day.plus({ days: int(r, 1, 3) }).toMillis() });
    }
  }
  // Unsorted, as the merged Slate plus Google read arrives.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function dayCountsFor(
  r: () => number,
  zone: string,
  fromMs: number,
  toMs: number,
  cap: number | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  const ceiling = cap ?? 8;
  for (const day of localDaysAround(zone, fromMs, toMs)) {
    const roll = r();
    const n = roll < 0.5 ? 0 : roll < 0.85 ? int(r, 1, ceiling - 1) : roll < 0.95 ? ceiling : ceiling + 1;
    if (n > 0) counts.set(day.toISODate()!, n);
  }
  return counts;
}

/** Booking starts for a member WITHOUT a server count, so the walk derives one. */
function bookingStarts(r: () => number, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const n = int(r, 0, 25);
  for (let i = 0; i < n; i++) out.push(fromMs - 86_400_000 + Math.floor(r() * (toMs - fromMs + 2 * 86_400_000)));
  return out;
}

export interface FixtureOptions {
  /** Pool size. */
  members: number;
  /** Zones the members are drawn from. */
  zones: readonly string[];
  /** Window start, as an org local date (yyyy-mm-dd), and how many days it spans. */
  fromDate: string;
  days: number;
  /** Mean busy blocks per member per day. */
  busyPerDay: number;
  durationMin: number;
  slotIntervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  dailyCap: number | null;
  /** How far before the window start "now" is, in minutes (negative puts now inside it). */
  nowLeadMin: number;
  /** Include rules a form would never write. */
  oddRules: boolean;
  /** Share of members on shift all seven days. Most clock changes happen on a
   *  Sunday, so a corpus of weekday shifts never meets one. */
  everyDayShare: number;
  /** Share of members carrying booking starts instead of a server day count. */
  derivedCountShare: number;
  businessHours: BusinessHoursRules;
  /** Window bounds shape: org midnight to midnight, the next-available probe's
   *  end of day (T03:59:59.999Z in October), or an arbitrary instant. */
  bounds: "midnight" | "end-of-day" | "ragged";
}

/** The benchmark's fixture: an 80 member pool at the live event type's settings. */
export function benchOptions(): FixtureOptions {
  return {
    members: 80,
    zones: ROSTER_ZONES,
    fromDate: "2026-10-19",
    days: 7,
    busyPerDay: 7,
    // The live Senior Loan Advisor Call: 20 minutes on a 10 minute grid, a 10/10 gap
    // (2026-10-02), the 120 minute notice default.
    durationMin: 20,
    slotIntervalMin: 10,
    bufferBeforeMin: 10,
    bufferAfterMin: 10,
    minNoticeMin: 120,
    dailyCap: 12,
    nowLeadMin: 60,
    oddRules: false,
    everyDayShare: 0,
    derivedCountShare: 0,
    businessHours: seededBusinessHours(),
    bounds: "end-of-day",
  };
}

export function buildFixture(seed: number, o: FixtureOptions): SlotComputeInput {
  const r = rng(seed);
  const orgZone = o.businessHours.zone;
  const startDay = DateTime.fromISO(o.fromDate, { zone: orgZone }).startOf("day");
  let fromMs = startDay.toMillis();
  let toMs: number;
  if (o.bounds === "midnight") toMs = startDay.plus({ days: o.days }).toMillis();
  else if (o.bounds === "end-of-day") toMs = startDay.plus({ days: o.days - 1 }).endOf("day").toMillis();
  else {
    fromMs += int(r, 0, 1439) * 60_000 + int(r, 0, 59) * 1000;
    toMs = fromMs + (o.days * 1440 - int(r, 0, 1439)) * 60_000 + int(r, 0, 999);
  }
  const members: MemberAvailability[] = [];
  for (let i = 0; i < o.members; i++) {
    const zone = pick(r, o.zones);
    const derived = r() < o.derivedCountShare;
    members.push({
      userId: `agent-${i}`,
      timezone: zone,
      rules: workingRules(r, o.oddRules && r() < 0.3, o.everyDayShare),
      busy: busyBlocks(r, zone, fromMs, toMs, o.busyPerDay),
      bookingStartsMs: derived ? bookingStarts(r, fromMs, toMs) : [],
      ...(derived ? {} : { dayCounts: dayCountsFor(r, zone, fromMs, toMs, o.dailyCap) }),
    });
  }
  return {
    members,
    durationMin: o.durationMin,
    bufferBeforeMin: o.bufferBeforeMin,
    bufferAfterMin: o.bufferAfterMin,
    minNoticeMin: o.minNoticeMin,
    dailyCap: o.dailyCap,
    slotIntervalMin: o.slotIntervalMin,
    businessHours: o.businessHours,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    nowMs: fromMs - o.nowLeadMin * 60_000,
  };
}
