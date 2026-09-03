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

const ordinal = (d: number): string => {
  if (d >= 11 && d <= 13) return "th";
  return d % 10 === 1 ? "st" : d % 10 === 2 ? "nd" : d % 10 === 3 ? "rd" : "th";
};

/** "240206" style stamp for the CSV filename (yesterday, ET). */
export function approvalsFileDate(nowMs: number): string {
  return DateTime.fromMillis(nowMs, { zone: ZONE })
    .minus({ days: 1 })
    .toFormat("yyMMdd");
}

/** "February 6th, 2026" style date for the subject/body (yesterday, ET). */
export function approvalsDisplayDate(nowMs: number): string {
  const d = DateTime.fromMillis(nowMs, { zone: ZONE }).minus({ days: 1 });
  return `${d.toFormat("LLLL")} ${d.day}${ordinal(d.day)}, ${d.year}`;
}

/** Subject + body, matching the original flow's copy verbatim. */
export function approvalsSubject(nowMs: number): string {
  return `Yesterday's OOO Approvals ${approvalsFileDate(nowMs)}`;
}
export function approvalsBody(nowMs: number): string {
  return `Please see the attached CSV with approvals from ${approvalsDisplayDate(nowMs)}`;
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
