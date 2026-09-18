import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";

/**
 * Pure core of the daily OOO-approvals report (port of the Pipedream flow that
 * read the sheet and emailed yesterday's approvals as a CSV). Side-effect-free
 * for `scripts/test-approvals-digest.ts`; the cron route does the DB + email IO.
 */

const ZONE = "America/New_York";
export const APPROVALS_HOUR_ET = 7;

/**
 * True at 7am ET, any day. The Cloudflare cron fires at both 11:00 and 12:00
 * UTC (one of which is 7am ET depending on DST); this guard lets exactly one
 * through and no-ops the other.
 */
export function isApprovalsDigestTime(nowMs: number): boolean {
  return DateTime.fromMillis(nowMs, { zone: ZONE }).hour === APPROVALS_HOUR_ET;
}

/**
 * The UTC [start, end) covering "yesterday" in ET — the window we match
 * `decided_at` against to find requests approved yesterday.
 */
export function yesterdayEtRange(nowMs: number): { startIso: string; endIso: string } {
  const startOfToday = DateTime.fromMillis(nowMs, { zone: ZONE }).startOf("day");
  return {
    startIso: startOfToday.minus({ days: 1 }).toUTC().toISO()!,
    endIso: startOfToday.toUTC().toISO()!,
  };
}

/**
 * The furthest back one catch-up report will reach (#2543).
 *
 * A gap longer than this is reported as far back as this allows and SAYS so,
 * rather than either emailing an unbounded CSV or quietly dropping the older
 * days. Seven days because a report covering more than a week is a different
 * document from a morning summary, and a gap that long is a fault somebody has to
 * look at rather than something the lane should absorb in silence.
 */
export const APPROVALS_CATCHUP_MAX_DAYS = 7;

/**
 * What one run of the approvals report has to cover.
 *
 * WHY THIS EXISTS (#2543). The window used to be "yesterday", derived from the
 * clock alone, and the lane gets exactly one attempt a day with no cron retry. So
 * a morning the lane missed (a thrown read since #2519, a dropped cron, a bad
 * deploy) fell out of every later run's window and its approvals were never
 * reported at all. A WATERMARK is what fixes that, and it is worth more than a
 * second trigger, because a second trigger still loses the day when both fire into
 * the same broken read.
 *
 * The watermark is the stamp of the last report that WENT OUT (the
 * `lane_heartbeats` row `ooo-approvals-report`). A run always covers up to the ET
 * midnight of the day it runs on, whatever it starts from, so that stamp's ET day
 * start IS the instant the last report covered through: an exact derivation rather
 * than an inference about what probably happened.
 *
 * `days === 0` means nothing is left to cover, which is what the second daily cron
 * trigger and a `?force=1` re-run both produce. It is the reason a catch-up run is
 * safe to repeat.
 */
export interface ApprovalsWindow {
  startIso: string;
  endIso: string;
  /** Whole ET days in [start, end). Zero means nothing is left to report. */
  days: number;
  /** The gap was longer than the cap, so earlier days are NOT in this report. */
  capped: boolean;
}

export function approvalsWindow(nowMs: number, lastReportMs: number | null): ApprovalsWindow {
  const todayStart = DateTime.fromMillis(nowMs, { zone: ZONE }).startOf("day");
  const yesterday = todayStart.minus({ days: 1 });
  const floor = todayStart.minus({ days: APPROVALS_CATCHUP_MAX_DAYS });

  let start =
    lastReportMs === null
      ? yesterday
      : DateTime.fromMillis(lastReportMs, { zone: ZONE }).startOf("day");
  let capped = false;
  if (start < floor) {
    start = floor;
    capped = true;
  }
  // A stamp at or ahead of this morning covers nothing. Clamped rather than left
  // to produce a negative range, because a reversed window would read as a
  // perfectly ordinary empty day.
  if (start > todayStart) start = todayStart;

  return {
    startIso: start.toUTC().toISO()!,
    endIso: todayStart.toUTC().toISO()!,
    days: Math.max(0, Math.round(todayStart.diff(start, "days").days)),
    capped,
  };
}

const ordinal = (d: number): string => {
  if (d >= 11 && d <= 13) return "th";
  return d % 10 === 1 ? "st" : d % 10 === 2 ? "nd" : d % 10 === 3 ? "rd" : "th";
};

/** The first and last ET days a window covers. */
function windowDays(w: ApprovalsWindow): { first: DateTime; last: DateTime } {
  const first = DateTime.fromISO(w.startIso, { zone: ZONE });
  // `endIso` is exclusive (this morning's ET midnight), so the last day covered is
  // the one before it.
  const last = DateTime.fromISO(w.endIso, { zone: ZONE }).minus({ days: 1 });
  return { first, last };
}

const stamp = (d: DateTime): string => d.toFormat("yyMMdd");
const friendly = (d: DateTime): string =>
  `${d.toFormat("LLLL")} ${d.day}${ordinal(d.day)}, ${d.year}`;

/**
 * "240206" for the CSV filename, or "240201 to 240206" for a caught-up report.
 *
 * "to" rather than a hyphen: a filename is copy too, and the dash rule the rest of
 * the product's words follow applies to it.
 */
export function approvalsFileDate(w: ApprovalsWindow): string {
  const { first, last } = windowDays(w);
  return w.days <= 1 ? stamp(last) : `${stamp(first)} to ${stamp(last)}`;
}

/** "February 6th, 2026" style date for the subject/body (yesterday, ET). */
export function approvalsDisplayDate(nowMs: number): string {
  const d = DateTime.fromMillis(nowMs, { zone: ZONE }).minus({ days: 1 });
  return `${d.toFormat("LLLL")} ${d.day}${ordinal(d.day)}, ${d.year}`;
}

/**
 * Subject + body. On the ordinary morning they match the original flow's copy
 * verbatim; a report covering more than one day says so instead.
 *
 * It may not keep calling itself yesterday's (L11): a reader filing these by
 * subject would otherwise get two "Yesterday's" reports naming different days,
 * with nothing saying that one of them holds a week.
 */
export function approvalsSubject(w: ApprovalsWindow): string {
  const dates = approvalsFileDate(w);
  return w.days <= 1 ? `Yesterday's OOO Approvals ${dates}` : `OOO Approvals ${dates}`;
}

export function approvalsBody(w: ApprovalsWindow): string {
  const { first, last } = windowDays(w);
  if (w.days <= 1) {
    return `Please see the attached CSV with approvals from ${friendly(last)}`;
  }
  const covered =
    `Please see the attached CSV with approvals from ${friendly(first)} to ${friendly(last)}. ` +
    `It covers ${w.days} days rather than one because the report did not go out on every ` +
    `morning in that range.`;
  if (!w.capped) return covered;
  return (
    `${covered} Approvals decided before ${friendly(first)} are not in this report. ` +
    `They are on the time off page in Slate.`
  );
}

// Display-label -> IANA zone for rendering each request's times in its own tz.
const TZ_BY_LABEL: Record<string, string> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
};

/** "Feb 6, 2026, 3:00 PM ET" in the request's display timezone. */
export function formatApprovalTime(iso: string, tzLabel: string): string {
  const zone = TZ_BY_LABEL[tzLabel] ?? "America/New_York";
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) return iso;
  // The time is spelled by the shared formatter, so this digest cannot drift into
  // a fourth spelling of one time (#1765). The DATE stays local to this line: it
  // is a different fact with its own format.
  return `${dt.toFormat("LLL d, yyyy")}, ${formatClockTime(dt) ?? ""} ${tzLabel}`;
}

export interface ApprovalRow {
  request_id: string;
  agent_name: string | null;
  manager_name: string | null;
  starts_at: string;
  ends_at: string;
  decided_at: string;
  display_tz_label: string;
}

const escapeCsv = (val: string | null): string => {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_HEADER = [
  "request_id",
  "agent_name",
  "start_time",
  "end_time",
  "manager_name",
  "approved_at",
];

/** Build the approvals CSV, columns + time formatting matching the old flow. */
export function buildApprovalsCsv(rows: ApprovalRow[]): string {
  const lines = rows.map((r) =>
    [
      escapeCsv(r.request_id),
      escapeCsv(r.agent_name),
      escapeCsv(formatApprovalTime(r.starts_at, r.display_tz_label)),
      escapeCsv(formatApprovalTime(r.ends_at, r.display_tz_label)),
      escapeCsv(r.manager_name),
      escapeCsv(formatApprovalTime(r.decided_at, r.display_tz_label)),
    ].join(","),
  );
  return [CSV_HEADER.join(","), ...lines].join("\n");
}
