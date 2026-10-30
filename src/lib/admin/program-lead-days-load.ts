/**
 * The reads behind the program leads admin page's 14 days (#4392). Server only.
 *
 * Every read THROWS on a failure, so the page draws its unreadable state rather than a
 * fortnight of zeros, which would read as a program nobody used (L10). The bookings and
 * the calls are read every page through (`selectAllPages`, `inIdChunks`), never one capped
 * page, and the outcomes are bounded by their primary key and checked for truncation.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import {
  buildProgramLeadDays,
  programLeadDaysWindow,
  PROGRAM_LEAD_DAYS_SHOWN,
  type ProgramLeadDay,
  type ProgramLeadOutcomeRow,
} from "@/lib/admin/program-lead-days";
import { bookingLeadKey, PLACEHOLDER_CALL_EARLY_MS } from "@/lib/monitor/placeholder-calls";
import {
  loadCallFeedNewestReceivedMs,
  loadPlaceholderCalls,
  loadProgramLeadBookings,
} from "@/lib/monitor/placeholder-calls-store";

type Db = ReturnType<typeof supabaseAdmin>;

/** The kinds migration 0215's check allows, so a day holds at most this many rows. */
const OUTCOME_KINDS = 2;

/** The outcome rows for the days shown. THROWS on a failed read or a read that may be cut short. */
async function loadProgramLeadOutcomes(db: Db, oldestDay: string, today: string): Promise<ProgramLeadOutcomeRow[]> {
  // One row per (day, kind) is the primary key, so `most` is every row; one more than
  // that means a new kind exists and the page would be dropping some of it.
  const most = PROGRAM_LEAD_DAYS_SHOWN * OUTCOME_KINDS;
  const rows = unwrap(
    await db.from("program_lead_outcomes").select("day, kind, occurrences").gte("day", oldestDay).lte("day", today).limit(most + 1),
    "program lead outcomes",
  ) as ProgramLeadOutcomeRow[];
  if (rows.length > most) throw new Error(`program_lead_outcomes holds more than ${most} rows for ${PROGRAM_LEAD_DAYS_SHOWN} days`);
  return rows;
}

/** The 14 days, newest first. THROWS when any read fails. */
export async function loadProgramLeadDays(nowMs: number): Promise<ProgramLeadDay[]> {
  const db = supabaseAdmin();
  const window = programLeadDaysWindow(nowMs);
  const [bookings, feedNewestMs, outcomes] = await Promise.all([
    loadProgramLeadBookings(db, window.fromIso, window.untilIso),
    loadCallFeedNewestReceivedMs(db),
    loadProgramLeadOutcomes(db, window.days[window.days.length - 1]!, window.days[0]!),
  ]);
  // The calls only the placeholder's bookings are judged against, from the early edge of
  // the earliest of them, exactly as the monitor reads them.
  const placeholder = bookings.filter((b) => b.kind === "staff_placed");
  const keys = [...new Set(placeholder.map(bookingLeadKey).filter((k): k is string => k !== null))];
  const starts = placeholder.map((b) => parseStampMs(b.starts_at)).filter((ms): ms is number => ms !== null);
  const calls =
    keys.length === 0 || starts.length === 0
      ? []
      : await loadPlaceholderCalls(db, keys, new Date(Math.min(...starts) - PLACEHOLDER_CALL_EARLY_MS).toISOString());
  return buildProgramLeadDays({ days: window.days, bookings, calls, feedNewestMs, outcomes, nowMs });
}
